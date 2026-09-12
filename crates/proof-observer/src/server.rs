use crate::{bridge::verify_peer, protocol::*};
use serde::Serialize;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::{
            fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
            net::{UnixListener, UnixStream},
        },
    },
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, TrySendError},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

const MAX_CONNECTIONS: usize = 8;
const QUEUE_SIZE: usize = 4;
const CONNECTION_DEADLINE: Duration = Duration::from_millis(200);

pub struct Envelope {
    pub header: Header,
    pub payload: Vec<u8>,
    pub policy_revision: u64,
    pub received_at: u64,
    pub foreground_lease_until: Option<u64>,
}

/// Capture GUI presence and consent at the receive boundary. An event waiting
/// for ingestion cannot acquire permissions from a later resume or GUI launch.
pub struct ReceiptPolicy {
    pub revision: u64,
    pub foreground_lease_until: Option<u64>,
}

#[derive(Default)]
pub struct Metrics {
    received: AtomicU64,
    processed: AtomicU64,
    rejected: AtomicU64,
    invalid: AtomicU64,
    expired: AtomicU64,
    queue_full: AtomicU64,
    storage_rejected: AtomicU64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsSnapshot {
    pub schema_version: u32,
    pub received: u64,
    pub processed: u64,
    pub rejected: u64,
    pub invalid: u64,
    pub expired: u64,
    pub queue_full: u64,
    pub storage_rejected: u64,
    pub max_connections: usize,
    pub queue_capacity: usize,
}
impl Metrics {
    pub fn snapshot(&self) -> MetricsSnapshot {
        MetricsSnapshot {
            schema_version: SCHEMA_VERSION,
            received: self.received.load(Ordering::Relaxed),
            processed: self.processed.load(Ordering::Relaxed),
            rejected: self.rejected.load(Ordering::Relaxed),
            invalid: self.invalid.load(Ordering::Relaxed),
            expired: self.expired.load(Ordering::Relaxed),
            queue_full: self.queue_full.load(Ordering::Relaxed),
            storage_rejected: self.storage_rejected.load(Ordering::Relaxed),
            max_connections: MAX_CONNECTIONS,
            queue_capacity: QUEUE_SIZE,
        }
    }
    pub fn note_storage_rejection(&self) {
        self.storage_rejected.fetch_add(1, Ordering::Relaxed);
    }
}

pub struct Server {
    listener: UnixListener,
    path: PathBuf,
    identity: (u64, u64),
    _lease: File,
    pub metrics: Arc<Metrics>,
}
impl Server {
    pub fn bind(path: &Path) -> Result<Self> {
        let parent = path.parent().ok_or(TransportError::Configuration)?;
        fs::create_dir_all(parent).map_err(|_| TransportError::Io)?;
        let parent_meta = fs::symlink_metadata(parent).map_err(|_| TransportError::Io)?;
        if !parent_meta.is_dir()
            || parent_meta.file_type().is_symlink()
            || parent_meta.uid() != unsafe { libc::geteuid() }
        {
            return Err(TransportError::Permission);
        }
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|_| TransportError::Permission)?;
        let lease = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(parent.join("observer.lock"))
            .map_err(|_| TransportError::Io)?;
        let metadata = lease.metadata().map_err(|_| TransportError::Io)?;
        if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() } {
            return Err(TransportError::Permission);
        }
        if unsafe { libc::flock(lease.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(TransportError::Unavailable);
        }
        if let Ok(meta) = fs::symlink_metadata(path) {
            if !meta.file_type().is_socket() || meta.uid() != unsafe { libc::geteuid() } {
                return Err(TransportError::Permission);
            }
            fs::remove_file(path).map_err(|_| TransportError::Io)?;
        }
        let listener = UnixListener::bind(path).map_err(|_| TransportError::Unavailable)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|_| TransportError::Permission)?;
        listener
            .set_nonblocking(true)
            .map_err(|_| TransportError::Io)?;
        let metadata = fs::symlink_metadata(path).map_err(|_| TransportError::Io)?;
        Ok(Self {
            listener,
            path: path.to_path_buf(),
            identity: (metadata.dev(), metadata.ino()),
            _lease: lease,
            metrics: Arc::new(Metrics::default()),
        })
    }
    /// Ingestion is isolated from socket reads by a strictly bounded queue. The
    /// callback must filter authorization in its persistence transaction.
    pub fn run(
        self,
        running: Arc<AtomicBool>,
        mut receipt_policy: impl FnMut() -> Option<ReceiptPolicy>,
        mut ingest: impl FnMut(Envelope) -> bool + Send + 'static,
        mut heartbeat: impl FnMut(&MetricsSnapshot),
    ) -> Result<()> {
        let (send, receive) = mpsc::sync_channel::<Envelope>(QUEUE_SIZE);
        let metrics = self.metrics.clone();
        let worker_running = running.clone();
        let worker = thread::Builder::new()
            .name("proof-observe-store".into())
            .spawn(move || {
                while let Ok(envelope) = receive.recv() {
                    if !worker_running.load(Ordering::Acquire) {
                        break;
                    }
                    let accepted = ingest(envelope);
                    if accepted {
                        metrics.processed.fetch_add(1, Ordering::Relaxed);
                    } else {
                        metrics.rejected.fetch_add(1, Ordering::Relaxed);
                    }
                }
            })
            .map_err(|_| TransportError::Unavailable)?;
        let mut connections: Vec<Connection> = Vec::new();
        let mut last_heartbeat = Instant::now() - Duration::from_secs(1);
        while running.load(Ordering::Acquire) {
            for _ in 0..MAX_CONNECTIONS {
                match self.listener.accept() {
                    Ok((stream, _)) => {
                        if connections.len() >= MAX_CONNECTIONS || verify_peer(&stream).is_err() {
                            self.metrics.rejected.fetch_add(1, Ordering::Relaxed);
                            continue;
                        }
                        let Some(policy) = receipt_policy() else {
                            self.metrics.rejected.fetch_add(1, Ordering::Relaxed);
                            continue;
                        };
                        stream
                            .set_nonblocking(true)
                            .map_err(|_| TransportError::Io)?;
                        connections.push(Connection {
                            stream,
                            bytes: Vec::new(),
                            started: Instant::now(),
                            header: None,
                            header_len: None,
                            policy_revision: policy.revision,
                            received_at: now(),
                            foreground_lease_until: policy.foreground_lease_until,
                        });
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => return Err(TransportError::Io),
                }
            }
            let mut index = 0;
            while index < connections.len() {
                let outcome = connections[index].read_frame();
                match outcome {
                    Ok(None) => {
                        index += 1;
                        continue;
                    }
                    Ok(Some(envelope)) => {
                        self.metrics.received.fetch_add(1, Ordering::Relaxed);
                        match send.try_send(envelope) {
                            Ok(()) => {}
                            Err(TrySendError::Full(_)) => {
                                self.metrics.queue_full.fetch_add(1, Ordering::Relaxed);
                            }
                            Err(TrySendError::Disconnected(_)) => {
                                return Err(TransportError::Unavailable)
                            }
                        }
                    }
                    Err(TransportError::Deadline) => {
                        self.metrics.expired.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(_) => {
                        self.metrics.invalid.fetch_add(1, Ordering::Relaxed);
                    }
                }
                connections.swap_remove(index);
            }
            if last_heartbeat.elapsed() >= Duration::from_secs(1) {
                heartbeat(&self.metrics.snapshot());
                last_heartbeat = Instant::now();
            }
            // A short idle poll avoids busy-spinning and leaves queue processing
            // independent. Bridge writes do not wait for ingestion or heartbeat.
            let mut poll = libc::pollfd {
                fd: self.listener.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            unsafe {
                libc::poll(&mut poll, 1, if connections.is_empty() { 25 } else { 2 });
            }
        }
        drop(connections);
        drop(send);
        worker.join().map_err(|_| TransportError::Unavailable)?;
        heartbeat(&self.metrics.snapshot());
        Ok(())
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        // Preserve a replacement path even if it was created outside the lease.
        if fs::symlink_metadata(&self.path)
            .is_ok_and(|m| m.file_type().is_socket() && (m.dev(), m.ino()) == self.identity)
        {
            let _ = fs::remove_file(&self.path);
        }
        unsafe {
            libc::flock(self._lease.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

struct Connection {
    stream: UnixStream,
    bytes: Vec<u8>,
    started: Instant,
    header: Option<Header>,
    header_len: Option<usize>,
    policy_revision: u64,
    received_at: u64,
    foreground_lease_until: Option<u64>,
}
impl Connection {
    fn read_frame(&mut self) -> Result<Option<Envelope>> {
        if self.started.elapsed() > CONNECTION_DEADLINE {
            return Err(TransportError::Deadline);
        }
        let mut chunk = [0u8; 16384];
        // At most 64 KiB per connection per pass, so one producer cannot starve
        // peers or allocate past the frame cap before its length is checked.
        for _ in 0..4 {
            match self.stream.read(&mut chunk) {
                Ok(0) => return Err(TransportError::Protocol),
                Ok(length) => self.bytes.extend_from_slice(&chunk[..length]),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return Err(TransportError::Io),
            }
            if self.header_len.is_none() && self.bytes.len() >= 4 {
                let length = u32::from_be_bytes(
                    self.bytes[..4]
                        .try_into()
                        .map_err(|_| TransportError::Protocol)?,
                ) as usize;
                if length == 0 || length > MAX_HEADER {
                    return Err(TransportError::Protocol);
                }
                self.header_len = Some(length);
            }
            if let Some(length) = self.header_len {
                if self.header.is_none() && self.bytes.len() >= length + 4 {
                    let header: Header = serde_json::from_slice(&self.bytes[4..4 + length])
                        .map_err(|_| TransportError::Protocol)?;
                    if header.schema_version != SCHEMA_VERSION
                        || header.payload_bytes > MAX_INPUT
                        || header.token.len() != 64
                        || header.agent_version.len() > 64
                        || uuid::Uuid::parse_str(&header.installation_id).is_err()
                        || (header.fault.is_some()
                            && (header.fault.as_deref() != Some("input_limit")
                                || header.payload_bytes != 0))
                    {
                        return Err(TransportError::Protocol);
                    }
                    self.header = Some(header);
                }
                if let Some(header) = &self.header {
                    let total = length + 4 + header.payload_bytes;
                    if self.bytes.len() > total {
                        return Err(TransportError::Protocol);
                    }
                    if self.bytes.len() == total {
                        let payload = self.bytes.split_off(length + 4);
                        return Ok(Some(Envelope {
                            header: self.header.take().ok_or(TransportError::Protocol)?,
                            payload,
                            policy_revision: self.policy_revision,
                            received_at: self.received_at,
                            foreground_lease_until: self.foreground_lease_until,
                        }));
                    }
                }
            }
            if self.bytes.len() > MAX_INPUT + MAX_HEADER + 4 {
                return Err(TransportError::InputLimit);
            }
        }
        Ok(None)
    }
}

pub fn write_health(path: &Path, value: &impl Serialize) -> Result<()> {
    let temp = path.with_extension("pending");
    let bytes = serde_json::to_vec(value).map_err(|_| TransportError::Protocol)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&temp)
        .map_err(|_| TransportError::Io)?;
    file.write_all(&bytes).map_err(|_| TransportError::Io)?;
    file.sync_all().map_err(|_| TransportError::Io)?;
    fs::rename(temp, path).map_err(|_| TransportError::Io)?;
    Ok(())
}
