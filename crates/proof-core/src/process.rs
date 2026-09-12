use crate::error::{Error, Result};
use std::{
    io::{Read, Write},
    path::Path,
    process::{Command, Stdio},
    thread,
    time::Duration,
};
use wait_timeout::ChildExt;

const OUTPUT_LIMIT: usize = 32 * 1024 * 1024;
pub struct Output {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

// Drain pipes concurrently, retaining bounded data. A timeout kills only the process
// group created for this operation, never an existing Git/Agent process.
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
