use crate::{
    protocol::*,
    server::{self, ReceiptPolicy, Server},
};
use proof_core::{ObserverInput, Proof};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

static STOP: AtomicBool = AtomicBool::new(false);
extern "C" fn stop(_: libc::c_int) {
    STOP.store(true, Ordering::Relaxed);
}

pub fn socket_path(data_dir: &Path) -> Result<PathBuf> {
    let key = format!(
        "{:x}",
        Sha256::digest(data_dir.as_os_str().as_encoded_bytes())
    );
    // macOS sockaddr_un paths are short. Use a same-user private runtime root;
    // each application data directory gets an independent socket and lease.
    let base = if cfg!(target_os = "macos") {
        "/private/tmp"
    } else {
        "/tmp"
    };
    let root = PathBuf::from(format!("{base}/proof-observer-{}", unsafe {
        libc::geteuid()
    }));
    match fs::create_dir(&root) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(TransportError::Io),
    }
    let meta = fs::symlink_metadata(&root).map_err(|_| TransportError::Io)?;
    if !meta.is_dir() || meta.file_type().is_symlink() || meta.uid() != unsafe { libc::geteuid() } {
        return Err(TransportError::Permission);
    }
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
        .map_err(|_| TransportError::Permission)?;
    Ok(root.join(&key[..16]).join("observe.sock"))
}

pub fn serve(data_dir: &Path) -> Result<()> {
    let journal = Proof::open(data_dir).map_err(|_| TransportError::Configuration)?;
    let data_dir = fs::canonicalize(data_dir).map_err(|_| TransportError::Configuration)?;
    let runtime = data_dir.join("observer");
    fs::create_dir_all(&runtime).map_err(|_| TransportError::Io)?;
    fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700))
        .map_err(|_| TransportError::Permission)?;
    let health = runtime.join("runtime.json");
    let prior = read_private_json(&health);
    let path = socket_path(&data_dir)?;
    let server = Server::bind(&path)?;
    let metadata = Proof::open(&data_dir).map_err(|_| TransportError::Configuration)?;
    let start = now();
    let epoch = uuid::Uuid::new_v4().to_string();
    let gap = if prior
        .as_ref()
        .is_some_and(|p| p["cleanShutdown"].as_bool() != Some(true))
    {
        "collector_restart_integrity_unknown"
    } else {
        "collector_started"
    };
    let _ = metadata.record_observer_gap(None, gap, None);
    STOP.store(false, Ordering::Relaxed);
    let running = Arc::new(AtomicBool::new(true));
    let watchdog_running = running.clone();
    let finished = Arc::new(AtomicBool::new(false));
    let watchdog_finished = finished.clone();
    std::thread::Builder::new()
        .name("proof-observe-shutdown".into())
        .spawn(move || {
            while !watchdog_finished.load(Ordering::Acquire) {
                if STOP.load(Ordering::Relaxed) {
                    watchdog_running.store(false, Ordering::Release);
                    proof_core::cancel_owned_operations_for_shutdown();
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    if !watchdog_finished.load(Ordering::Acquire) {
                        unsafe {
                            libc::_exit(0);
                        }
                    }
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        })
        .map_err(|_| TransportError::Unavailable)?;
    unsafe {
        libc::signal(libc::SIGTERM, stop as *const () as libc::sighandler_t);
        libc::signal(libc::SIGINT, stop as *const () as libc::sighandler_t);
    }
    let control = running.clone();
    let metrics = server.metrics.clone();
    let ingestion_metrics = metrics.clone();
    let socket = path.to_string_lossy().to_string();
    let mut last_queue = 0;
    let mut last_invalid = 0;
    let mut last_expired = 0;
    let mut last_storage = 0;
    let mut last_cleanup = std::time::Instant::now();
    let lease_path = runtime.join("foreground.json");
    server.run(running,||Some(ReceiptPolicy { revision: metadata.observer_policy_revision().ok()?, foreground_lease_until:foreground_lease(&lease_path) }),move |envelope| {
        let h=envelope.header;
        if h.fault.is_some() {
            if journal.observer_transport_authorized(&h.installation_id,&h.token,h.agent,&h.agent_version).unwrap_or(false) { let _=journal.record_observer_gap(Some(&h.installation_id),"transport_input_limit",Some(1)); }
            return false;
        }
        match journal.ingest_observer_event(ObserverInput {installation_id:&h.installation_id,token:&h.token,agent:h.agent,agent_version:&h.agent_version,payload:&envelope.payload,
            bridge_started_at:h.bridge_started_at,foreground_lease_until:envelope.foreground_lease_until,received_policy_revision:envelope.policy_revision,received_at:envelope.received_at}) {
            Ok(stored)=>stored,
            Err(error)=>{if ["STORAGE_ERROR","IO_ERROR","OBSERVER_STORAGE_LIMIT","OBSERVER_STORAGE_MEASUREMENT_LIMIT"].contains(&error.code.as_str()) {ingestion_metrics.note_storage_rejection();} false}
        }
    },|snapshot| {
        if last_cleanup.elapsed()>=std::time::Duration::from_secs(60) {
            if metadata.maintain_local_data().is_err() {let _=metadata.record_observer_gap(None,"storage_rejected",None);}
            last_cleanup=std::time::Instant::now();
        }
        for (value,previous,code) in [(snapshot.queue_full,&mut last_queue,"transport_queue_full"),(snapshot.invalid,&mut last_invalid,"transport_invalid"),(snapshot.expired,&mut last_expired,"transport_expired"),(snapshot.storage_rejected,&mut last_storage,"storage_rejected")] {
            if value>*previous {let _=metadata.record_observer_gap(None,code,Some(value-*previous));*previous=value;}
        }
        let _=server::write_health(&health,&json!({"schemaVersion":1,"adapterVersion":OBSERVER_VERSION,"epoch":epoch,"pid":std::process::id(),"startedAt":start,"heartbeatAt":now(),"cleanShutdown":false,"socketPath":socket,"metrics":snapshot}));
        if STOP.load(Ordering::Relaxed) {control.store(false,Ordering::Release);}
        if foreground_lease(&lease_path).is_none() && !metadata.observer_consents().unwrap_or_default().iter().any(|c|c.enabled && c.background) {STOP.store(true,Ordering::Relaxed);control.store(false,Ordering::Release);}
    })?;
    let _ = metadata.record_observer_gap(None, "collector_stopped", None);
    server::write_health(
        &health,
        &json!({"schemaVersion":1,"adapterVersion":OBSERVER_VERSION,"epoch":epoch,"pid":std::process::id(),"startedAt":start,"heartbeatAt":now(),"cleanShutdown":true,"socketPath":socket,"metrics":metrics.snapshot()}),
    )?;
    finished.store(true, Ordering::Release);
    Ok(())
}
const OBSERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

fn read_private_json(path: &Path) -> Option<serde_json::Value> {
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(4097).read_to_end(&mut bytes).ok()?;
    if bytes.len() > 4096 {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}
fn foreground_lease(path: &Path) -> Option<u64> {
    let until = read_private_json(path)?["validUntil"].as_u64()?;
    let current = now();
    (until > current && until <= current + 10_000).then_some(until)
}
