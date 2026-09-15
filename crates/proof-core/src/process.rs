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

type StdoutObserver<'a> = &'a mut dyn FnMut(&[u8]);

const OUTPUT_LIMIT: usize = 32 * 1024 * 1024;
pub fn run(command: Command, input: Option<&[u8]>, timeout: Duration) -> Result<Output> {
    run_inner(command, input, timeout, None, None)
}
// Only read-only Diff commands terminate early; writes retain full verification.
pub(crate) fn run_diff(
    command: Command,
    input: Option<&[u8]>,
    timeout: Duration,
    limit: usize,
) -> Result<Output> {
    run_inner(command, input, timeout, Some(limit.min(OUTPUT_LIMIT)), None)
}
/// Stream owned process stdout as it arrives while retaining bounded final output.
pub(crate) fn run_observed(
    command: Command,
    input: Option<&[u8]>,
    timeout: Duration,
    observer: &mut dyn FnMut(&[u8]),
) -> Result<Output> {
    run_inner(command, input, timeout, Some(OUTPUT_LIMIT), Some(observer))
}
fn diff_limit_error(limit: usize) -> Error {
    Error::new("DIFF_OUTPUT_LIMIT", "Diff 超过当前读取范围。", limit)
}
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
fn run_inner(
    mut command: Command,
    input: Option<&[u8]>,
    timeout: Duration,
    diff_limit: Option<usize>,
    mut observer: Option<StdoutObserver<'_>>,
) -> Result<Output> {
    crate::check_read_cancellation()?;
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
    fn drain(
        mut pipe: impl Read,
        limit: usize,
        notify: Option<std::sync::Arc<AtomicBool>>,
    ) -> std::io::Result<(Vec<u8>, bool)> {
        let mut result = Vec::new();
        let mut buf = [0u8; 8192];
        let mut exceeded = false;
        loop {
            let n = pipe.read(&mut buf)?;
            if n == 0 {
                break;
            }
            let keep = n.min(limit.saturating_sub(result.len()));
            result.extend_from_slice(&buf[..keep]);
            exceeded |= keep < n;
            if exceeded {
                if let Some(notify) = &notify {
                    notify.store(true, Ordering::Release);
                }
            }
        }
        Ok((result, exceeded))
    }
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let diff_exceeded = std::sync::Arc::new(AtomicBool::new(false));
    let notification = diff_limit.map(|_| diff_exceeded.clone());
    let out =
        thread::spawn(move || drain(stdout, diff_limit.unwrap_or(OUTPUT_LIMIT), notification));
    let err = thread::spawn(move || drain(stderr, OUTPUT_LIMIT, None));
    let deadline = std::time::Instant::now() + timeout;
    let mut cancelled = None;
    let status = loop {
        if let Err(error) = crate::check_read_cancellation() {
            cancelled = Some(error);
            break None;
        }
        if diff_exceeded.load(Ordering::Acquire) {
            break None;
        }
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            break None;
        }
        if let Some(status) = child.wait_timeout(remaining.min(Duration::from_millis(20)))? {
            break Some(status);
        }
    };
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
    if let Some(error) = cancelled {
        return Err(error);
    }
    if diff_exceeded.load(Ordering::Acquire) {
        return Err(diff_limit_error(diff_limit.unwrap()));
    }
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
    if let Some(observer) = observer.as_mut() {
        observer(&stdout);
    }
    Ok(Output {
        code: status.unwrap().code().unwrap_or(-1),
        stdout,
        stderr,
    })
}

#[cfg(unix)]
fn run_inner(
    mut command: Command,
    input: Option<&[u8]>,
    timeout: Duration,
    diff_limit: Option<usize>,
    mut observer: Option<StdoutObserver<'_>>,
) -> Result<Output> {
    use std::{
        os::{fd::AsRawFd, unix::process::CommandExt},
        time::Instant,
    };
    crate::check_read_cancellation()?;
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
    let exit_status = loop {
        crate::check_read_cancellation()?;
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
        // Once all pipes close there is no fd left to wake poll on child exit.
        // Reap promptly without installing a process-global SIGCHLD handler.
        let interval = if out_eof && err_eof && stdin.is_none() {
            1
        } else {
            10
        };
        let wait = deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
            .clamp(1, interval) as i32;
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
        for (poll, bytes, eof, is_stdout) in [
            (&polls[1], &mut out, &mut out_eof, true),
            (&polls[2], &mut err, &mut err_eof, false),
        ] {
            if poll.revents == 0 {
                continue;
            }
            let mut buffer = [0u8; 16384];
            let count = unsafe { libc::read(poll.fd, buffer.as_mut_ptr().cast(), buffer.len()) };
            if count == 0 {
                *eof = true;
            } else if count > 0 {
                if is_stdout {
                    if let Some(observer) = observer.as_mut() {
                        observer(&buffer[..count as usize]);
                    }
                }
                if is_stdout && diff_limit.is_some_and(|limit| bytes.len() + count as usize > limit)
                {
                    return Err(diff_limit_error(diff_limit.unwrap()));
                }
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
                break status;
            }
        }
    };
    owned.complete = true;
    if exceeded {
        return Err(Error::new(
            "OUTPUT_LIMIT",
            "内容超过读取上限，请缩小范围。",
            OUTPUT_LIMIT,
        ));
    }
    Ok(Output {
        code: exit_status.code().unwrap_or(-1),
        stdout: out,
        stderr: err,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn diff_output_limit_stops_a_live_producer_instead_of_draining_it() {
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            "while :; do printf '0123456789abcdef0123456789abcdef\\n'; done",
        ]);
        let started = std::time::Instant::now();
        let result = run_diff(command, None, Duration::from_secs(10), 1024);
        assert!(matches!(result, Err(error) if error.code == "DIFF_OUTPUT_LIMIT"));
        assert!(started.elapsed() < Duration::from_secs(1));
    }
    #[test]
    fn exited_parent_with_inherited_pipe_is_still_bounded() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 30 & exit 0"]);
        let started = std::time::Instant::now();
        let result = run(command, None, Duration::from_millis(100));
        assert!(matches!(result,Err(error) if error.code=="PROCESS_TIMEOUT"));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn closed_output_pipes_do_not_remove_the_process_deadline() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "exec 1>&- 2>&-; sleep 30"]);
        let started = std::time::Instant::now();
        let result = run(command, None, Duration::from_millis(100));
        assert!(matches!(result,Err(error) if error.code=="PROCESS_TIMEOUT"));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn closed_output_pipes_preserve_a_later_exit_status() {
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            "printf output; printf error >&2; exec 1>&- 2>&-; sleep .03; exit 7",
        ]);
        let result = run(command, None, Duration::from_secs(2)).unwrap();
        assert_eq!(result.code, 7);
        assert_eq!(result.stdout, b"output");
        assert_eq!(result.stderr, b"error");
    }

    #[test]
    fn child_can_still_read_input_after_closing_both_output_pipes() {
        let temp = tempfile::tempdir().unwrap();
        let saved = temp.path().join("input");
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "exec 1>&- 2>&-; cat > \"$1\"", "proof-test"]);
        command.arg(&saved);
        let input = vec![b'x'; 1024 * 1024];
        let result = run(command, Some(&input), Duration::from_secs(2)).unwrap();
        assert_eq!(result.code, 0);
        assert!(result.stdout.is_empty() && result.stderr.is_empty());
        assert_eq!(std::fs::read(saved).unwrap(), input);
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
