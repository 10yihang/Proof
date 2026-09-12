use crate::error::{Error, Result};
#[cfg(not(unix))]
use std::{
    io::{Read, Write},
    thread,
};
use std::{
    path::Path,
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use wait_timeout::ChildExt;

const OUTPUT_LIMIT: usize = 32 * 1024 * 1024;
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

/// One-way cancellation for this process's own Git operations. Used only by the
/// standalone collector at shutdown, never as an Agent control interface.
pub fn cancel_owned_operations_for_shutdown() {
    SHUTTING_DOWN.store(true, Ordering::Release);
}
pub struct Output {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

// Drain pipes concurrently, retaining bounded data. A timeout kills only the process
// group created for this operation, never an existing Git/Agent process.
#[cfg(not(unix))]
pub fn run(mut command: Command, input: Option<&[u8]>, timeout: Duration) -> Result<Output> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|e| {
        Error::new(
            "PROCESS_START",
            "无法启动所选 Git 程序，请检查程序路径。",
            e,
        )
    })?;
    let bytes = input.unwrap_or_default().to_vec();
    let mut stdin = child.stdin.take().unwrap();
    let writer = thread::spawn(move || {
        let result = stdin.write_all(&bytes);
        drop(stdin);
        result
    });
    fn drain(mut pipe: impl Read) -> std::io::Result<(Vec<u8>, bool)> {
        let mut result = Vec::new();
        let mut buf = [0u8; 8192];
        let mut exceeded = false;
        loop {
            let n = pipe.read(&mut buf)?;
            if n == 0 {
                break;
            }
            let keep = n.min(OUTPUT_LIMIT.saturating_sub(result.len()));
            result.extend_from_slice(&buf[..keep]);
            exceeded |= keep < n;
        }
        Ok((result, exceeded))
    }
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let out = thread::spawn(move || drain(stdout));
    let err = thread::spawn(move || drain(stderr));
    let status = child.wait_timeout(timeout)?;
    if status.is_none() {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
        let _ = child.kill();
        let _ = child.wait();
    }
    let _ = writer.join();
    let (stdout, out_exceeded) = out.join().map_err(|_| {
        Error::new(
            "PROCESS_READ",
            "无法读取 Git 输出。",
            "stdout reader failed",
        )
    })??;
    let (stderr, err_exceeded) = err.join().map_err(|_| {
        Error::new(
            "PROCESS_READ",
            "无法读取 Git 输出。",
            "stderr reader failed",
        )
    })??;
    if status.is_none() {
        return Err(Error::new(
            "PROCESS_TIMEOUT",
            "本次 Git 操作超时，请刷新并核对实际状态。",
            "Operation process exceeded its deadline",
        ));
    }
    if out_exceeded || err_exceeded {
        return Err(Error::new(
            "OUTPUT_LIMIT",
            "内容超过读取上限，请缩小范围。",
            OUTPUT_LIMIT,
        ));
    }
    Ok(Output {
        code: status.unwrap().code().unwrap_or(-1),
        stdout,
        stderr,
    })
}

#[cfg(unix)]
pub fn run(mut command: Command, input: Option<&[u8]>, timeout: Duration) -> Result<Output> {
    use std::{
        os::{fd::AsRawFd, unix::process::CommandExt},
        time::Instant,
    };
    if SHUTTING_DOWN.load(Ordering::Acquire) {
        return Err(Error::new(
            "PROCESS_CANCELLED",
            "采集服务正在停止，本次读取已取消。",
            "Collector shutdown",
        ));
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let child = command.spawn().map_err(|e| {
        Error::new(
            "PROCESS_START",
            "无法启动所选 Git 程序，请检查程序路径。",
            e,
        )
    })?;
    struct OwnedChild {
        child: std::process::Child,
        complete: bool,
    }
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            if !self.complete {
                unsafe {
                    libc::kill(-(self.child.id() as i32), libc::SIGKILL);
                }
                let _ = self.child.kill();
                let _ = self.child.wait_timeout(Duration::from_millis(200));
            }
        }
    }
    let mut owned = OwnedChild {
        child,
        complete: false,
    };
    let mut stdin = owned.child.stdin.take();
    let stdout = owned.child.stdout.take().unwrap();
    let stderr = owned.child.stderr.take().unwrap();
    for fd in [
        stdin.as_ref().unwrap().as_raw_fd(),
        stdout.as_raw_fd(),
        stderr.as_raw_fd(),
    ] {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    let mut input = input.unwrap_or_default();
    if input.is_empty() {
        stdin.take();
    }
    let deadline = Instant::now() + timeout;
    let mut out = Vec::new();
    let mut err = Vec::new();
    let mut out_eof = false;
    let mut err_eof = false;
    let mut exceeded = false;
    let mut status = None;
    loop {
        if SHUTTING_DOWN.load(Ordering::Acquire) {
            return Err(Error::new(
                "PROCESS_CANCELLED",
                "采集服务正在停止，本次读取已取消。",
                "Collector shutdown",
            ));
        }
        if Instant::now() >= deadline {
            return Err(Error::new(
                "PROCESS_TIMEOUT",
                "本次 Git 操作超时，请刷新并核对实际状态。",
                "Process or inherited output pipe exceeded deadline",
            ));
        }
        let mut polls = [
            libc::pollfd {
                fd: stdin.as_ref().map_or(-1, |s| s.as_raw_fd()),
                events: libc::POLLOUT,
                revents: 0,
            },
            libc::pollfd {
                fd: if out_eof { -1 } else { stdout.as_raw_fd() },
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: if err_eof { -1 } else { stderr.as_raw_fd() },
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        let wait = deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
            .clamp(1, 10) as i32;
        if unsafe { libc::poll(polls.as_mut_ptr(), polls.len() as libc::nfds_t, wait) } < 0
            && std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted
        {
            return Err(std::io::Error::last_os_error().into());
        }
        if polls[0].revents != 0 {
            let count =
                unsafe { libc::write(polls[0].fd, input.as_ptr().cast(), input.len().min(16384)) };
            if count > 0 {
                input = &input[count as usize..];
                if input.is_empty() {
                    stdin.take();
                }
            } else if count < 0
                && ![
                    std::io::ErrorKind::WouldBlock,
                    std::io::ErrorKind::Interrupted,
                ]
                .contains(&std::io::Error::last_os_error().kind())
            {
                stdin.take();
            }
        }
        for (poll, bytes, eof) in [
            (&polls[1], &mut out, &mut out_eof),
            (&polls[2], &mut err, &mut err_eof),
        ] {
            if poll.revents == 0 {
                continue;
            }
            let mut buffer = [0u8; 16384];
            let count = unsafe { libc::read(poll.fd, buffer.as_mut_ptr().cast(), buffer.len()) };
            if count == 0 {
                *eof = true;
            } else if count > 0 {
                let keep = (count as usize).min(OUTPUT_LIMIT.saturating_sub(bytes.len()));
                bytes.extend_from_slice(&buffer[..keep]);
                exceeded |= keep < count as usize;
            } else if ![
                std::io::ErrorKind::WouldBlock,
                std::io::ErrorKind::Interrupted,
            ]
            .contains(&std::io::Error::last_os_error().kind())
            {
                return Err(std::io::Error::last_os_error().into());
            }
        }
        if status.is_none() {
            status = owned.child.try_wait()?;
        }
        if let Some(status) = status {
            if out_eof && err_eof {
                owned.complete = true;
                if exceeded {
                    return Err(Error::new(
                        "OUTPUT_LIMIT",
                        "内容超过读取上限，请缩小范围。",
                        OUTPUT_LIMIT,
                    ));
                }
                return Ok(Output {
                    code: status.code().unwrap_or(-1),
                    stdout: out,
                    stderr: err,
                });
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn exited_parent_with_inherited_pipe_is_still_bounded() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 30 & exit 0"]);
        let started = std::time::Instant::now();
        let result = run(command, None, Duration::from_millis(100));
        assert!(matches!(result,Err(error) if error.code=="PROCESS_TIMEOUT"));
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}

pub fn git_command(git: &str, path: &Path) -> Command {
    let mut cmd = Command::new(git);
    cmd.arg("--no-pager")
        .arg("--literal-pathspecs")
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
        ])
        .arg("-C")
        .arg(path)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C");
    // Do not inherit the Agent's temporary index or alternate repository context.
    for var in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_COMMON_DIR",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    ] {
        cmd.env_remove(var);
    }
    cmd
}

pub fn checked(output: Output) -> Result<Vec<u8>> {
    if output.code != 0 {
        let detail = String::from_utf8_lossy(&output.stderr).into_owned();
        let (code, message) = if detail.contains("index.lock") {
            (
                "GIT_LOCKED",
                "另一个 Git 操作正在使用索引，请稍后刷新重试。",
            )
        } else if detail.contains("dubious ownership") {
            (
                "GIT_OWNERSHIP",
                "Git 拒绝读取此仓库的所有权配置，请在外部确认信任设置。",
            )
        } else {
            (
                "GIT_FAILED",
                "Git 未能完成本次操作，请查看详情并刷新实际状态。",
            )
        };
        Err(Error::new(code, message, detail))
    } else {
        Ok(output.stdout)
    }
}
