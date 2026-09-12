use crate::protocol::*;
use std::{path::Path, time::Instant};

#[cfg(unix)]
mod platform {
    use super::*;
    use std::{
        fs::OpenOptions,
        io::Read,
        mem,
        os::{
            fd::{AsRawFd, FromRawFd, RawFd},
            unix::{
                ffi::OsStrExt,
                fs::{MetadataExt, OpenOptionsExt},
                net::UnixStream,
            },
        },
    };

    pub fn silence_output() {
        if let Ok(null) = OpenOptions::new().write(true).open("/dev/null") {
            unsafe {
                libc::dup2(null.as_raw_fd(), libc::STDOUT_FILENO);
                libc::dup2(null.as_raw_fd(), libc::STDERR_FILENO);
            }
        }
    }
    fn remaining(deadline: Instant) -> Result<i32> {
        let left = deadline
            .checked_duration_since(Instant::now())
            .ok_or(TransportError::Deadline)?;
        Ok(left.as_millis().min(i32::MAX as u128).max(1) as i32)
    }
    fn poll(fd: RawFd, events: i16, deadline: Instant) -> Result<()> {
        loop {
            let mut entry = libc::pollfd {
                fd,
                events,
                revents: 0,
            };
            let result = unsafe { libc::poll(&mut entry, 1, remaining(deadline)?) };
            if result > 0 {
                return Ok(());
            }
            if result == 0 {
                return Err(TransportError::Deadline);
            }
            if std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
                return Err(TransportError::Io);
            }
        }
    }
    fn load_registration(path: &Path) -> Result<Registration> {
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(path)
            .map_err(|_| TransportError::Configuration)?;
        let metadata = file.metadata().map_err(|_| TransportError::Configuration)?;
        if !metadata.is_file()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
            || metadata.len() > 4096
        {
            return Err(TransportError::Permission);
        }
        let mut input = Vec::new();
        file.by_ref()
            .take(4097)
            .read_to_end(&mut input)
            .map_err(|_| TransportError::Configuration)?;
        if input.len() > 4096 {
            return Err(TransportError::Configuration);
        }
        serde_json::from_slice(&input).map_err(|_| TransportError::Configuration)
    }
    fn connect(path: &Path, deadline: Instant) -> Result<UnixStream> {
        let mut address: libc::sockaddr_un = unsafe { mem::zeroed() };
        let path = path.as_os_str().as_bytes();
        if path.is_empty() || path.len() >= address.sun_path.len() || path.contains(&0) {
            return Err(TransportError::Configuration);
        }
        address.sun_family = libc::AF_UNIX as libc::sa_family_t;
        for (out, byte) in address.sun_path.iter_mut().zip(path) {
            *out = *byte as libc::c_char;
        }
        let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
        if fd < 0 {
            return Err(TransportError::Unavailable);
        }
        let stream = unsafe { UnixStream::from_raw_fd(fd) };
        stream
            .set_nonblocking(true)
            .map_err(|_| TransportError::Io)?;
        if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
            return Err(TransportError::Io);
        }
        let result = unsafe {
            libc::connect(
                fd,
                (&address as *const libc::sockaddr_un).cast(),
                mem::size_of::<libc::sockaddr_un>() as libc::socklen_t,
            )
        };
        if result < 0 {
            let error = std::io::Error::last_os_error();
            if ![Some(libc::EINPROGRESS), Some(libc::EAGAIN)].contains(&error.raw_os_error()) {
                return Err(TransportError::Unavailable);
            }
            poll(fd, libc::POLLOUT, deadline)?;
            let mut status: i32 = 0;
            let mut len = mem::size_of_val(&status) as libc::socklen_t;
            if unsafe {
                libc::getsockopt(
                    fd,
                    libc::SOL_SOCKET,
                    libc::SO_ERROR,
                    (&mut status as *mut i32).cast(),
                    &mut len,
                )
            } < 0
                || status != 0
            {
                return Err(TransportError::Unavailable);
            }
        }
        verify_peer(&stream)?;
        Ok(stream)
    }
    pub fn verify_peer(stream: &UnixStream) -> Result<()> {
        #[cfg(any(target_os = "macos", target_os = "freebsd"))]
        {
            let mut uid = 0;
            let mut gid = 0;
            if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } < 0
                || uid != unsafe { libc::geteuid() }
            {
                return Err(TransportError::Permission);
            }
        }
        #[cfg(target_os = "linux")]
        {
            let mut peer: libc::ucred = unsafe { mem::zeroed() };
            let mut len = mem::size_of_val(&peer) as libc::socklen_t;
            if unsafe {
                libc::getsockopt(
                    stream.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_PEERCRED,
                    (&mut peer as *mut libc::ucred).cast(),
                    &mut len,
                )
            } < 0
                || peer.uid != unsafe { libc::geteuid() }
            {
                return Err(TransportError::Permission);
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "freebsd", target_os = "linux")))]
        return Err(TransportError::Permission);
        Ok(())
    }
    fn read_input(input: RawFd, deadline: Instant) -> Result<Vec<u8>> {
        let mut result = Vec::with_capacity(64 * 1024);
        let mut bytes = [0u8; 16384];
        loop {
            poll(input, libc::POLLIN, deadline)?;
            let count = unsafe { libc::read(input, bytes.as_mut_ptr().cast(), bytes.len()) };
            if count == 0 {
                return Ok(result);
            }
            if count < 0 {
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(TransportError::Io);
            }
            if result.len() + count as usize > MAX_INPUT {
                return Err(TransportError::InputLimit);
            }
            result.extend_from_slice(&bytes[..count as usize]);
        }
    }
    fn send(stream: &UnixStream, mut bytes: &[u8], deadline: Instant) -> Result<()> {
        while !bytes.is_empty() {
            poll(stream.as_raw_fd(), libc::POLLOUT, deadline)?;
            #[cfg(target_os = "macos")]
            {
                let value: i32 = 1;
                unsafe {
                    libc::setsockopt(
                        stream.as_raw_fd(),
                        libc::SOL_SOCKET,
                        libc::SO_NOSIGPIPE,
                        (&value as *const i32).cast(),
                        mem::size_of_val(&value) as libc::socklen_t,
                    );
                }
            }
            #[cfg(target_os = "linux")]
            let flags = libc::MSG_NOSIGNAL;
            #[cfg(not(target_os = "linux"))]
            let flags = 0;
            let count = unsafe {
                libc::send(
                    stream.as_raw_fd(),
                    bytes.as_ptr().cast(),
                    bytes.len(),
                    flags,
                )
            };
            if count > 0 {
                bytes = &bytes[count as usize..];
            } else if count == 0 {
                return Err(TransportError::Io);
            } else {
                let kind = std::io::Error::last_os_error().kind();
                if ![
                    std::io::ErrorKind::Interrupted,
                    std::io::ErrorKind::WouldBlock,
                ]
                .contains(&kind)
                {
                    return Err(TransportError::Io);
                }
            }
        }
        Ok(())
    }
    pub fn forward(registration: &Path, input: RawFd, deadline: Instant) -> Result<()> {
        let started_at = now();
        let registration = load_registration(registration)?;
        let (payload, fault) = match read_input(input, deadline) {
            Ok(input) => (input, None),
            Err(TransportError::InputLimit) => (Vec::new(), Some("input_limit")),
            Err(error) => return Err(error),
        };
        let stream = connect(Path::new(&registration.socket_path), deadline)?;
        let header = encode_header(&registration, payload.len(), started_at, fault)?;
        send(&stream, &header, deadline)?;
        send(&stream, &payload, deadline)?;
        Ok(())
    }
}

#[cfg(unix)]
pub use platform::{forward, silence_output, verify_peer};

#[cfg(not(unix))]
pub fn silence_output() {}
#[cfg(not(unix))]
pub fn forward(_: &Path, _: i32, _: Instant) -> Result<()> {
    Err(TransportError::Unavailable)
}
