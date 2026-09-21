//! 嵌入式终端：portable-pty 封装。
//!
//! 内存与生命周期约定（见 docs/TERMINAL-EMBEDDING-OPTIONS.md）：
//! - 前端首次打开终端面板时才 spawn，关闭/退出即 kill 子进程并回收句柄；
//! - 输出经 `Channel` 以 Raw 字节直推 webview，不走 JSON 字符串事件；
//! - 每个会话一个 reader 线程，EOF（子进程退出或句柄被回收）后线程自行结束。

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use proof_core::Error;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{ipc::InvokeResponseBody, AppHandle, Emitter, Manager};

fn failure(code: &str, message: &str, detail: impl ToString) -> Error {
    Error::new(code, message, detail)
}

struct TerminalHandle {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

impl Drop for TerminalHandle {
    fn drop(&mut self) {
        // 关闭面板/应用退出时确保子进程被回收，避免遗留 shell。
        let _ = self.child.kill();
    }
}

#[derive(Default)]
pub struct TerminalSet(Mutex<HashMap<String, TerminalHandle>>);

impl TerminalSet {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, HashMap<String, TerminalHandle>>, Error> {
        self.0
            .lock()
            .map_err(|_| failure("TERMINAL_UNAVAILABLE", "终端服务暂时不可用。", "Mutex poisoned"))
    }
}

#[derive(Clone, Serialize)]
struct TerminalExit {
    id: String,
}

#[cfg(windows)]
fn default_shell() -> (String, Vec<String>) {
    ("powershell.exe".to_string(), vec![])
}

#[cfg(not(windows))]
fn default_shell() -> (String, Vec<String>) {
    // 登录 shell 保证 GUI 环境下加载用户 profile（PATH 等）。
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    (shell, vec!["-l".to_string()])
}

fn spawn_reader(
    app: AppHandle,
    window_label: String,
    id: String,
    mut reader: Box<dyn Read + Send>,
    on_data: tauri::ipc::Channel,
) {
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    if on_data
                        .send(InvokeResponseBody::Raw(buffer[..n].to_vec()))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        // EOF：子进程退出或终端被关闭。回收句柄（释放 fd / reap 子进程），
        // 避免已退出会话滞留在注册表里；前端再根据事件更新界面。
        if let Some(terminals) = app.try_state::<TerminalSet>() {
            if let Ok(mut set) = terminals.0.lock() {
                set.remove(&id);
            }
        }
        let _ = app.emit_to(&window_label, "terminal-exit", TerminalExit { id });
    });
}

#[tauri::command]
pub fn terminal_spawn(
    window: tauri::WebviewWindow,
    terminals: tauri::State<'_, TerminalSet>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_data: tauri::ipc::Channel,
) -> Result<String, Error> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.clamp(2, 500),
            cols: cols.clamp(2, 500),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| failure("TERMINAL_SPAWN_FAILED", "无法创建终端。", error))?;
    let (shell, args) = default_shell();
    let mut command = CommandBuilder::new(&shell);
    for arg in args {
        command.arg(arg);
    }
    if let Some(dir) = cwd.filter(|dir| !dir.is_empty() && std::path::Path::new(dir).is_dir()) {
        command.cwd(dir);
    }
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "Proof");
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| failure("TERMINAL_SPAWN_FAILED", "无法启动 Shell。", error))?;
    drop(pair.slave);
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| failure("TERMINAL_SPAWN_FAILED", "无法读取终端输出。", error))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| failure("TERMINAL_SPAWN_FAILED", "无法写入终端。", error))?;
    let id = uuid::Uuid::new_v4().to_string();
    spawn_reader(
        window.app_handle().clone(),
        window.label().to_owned(),
        id.clone(),
        reader,
        on_data,
    );
    terminals.lock()?.insert(
        id.clone(),
        TerminalHandle {
            master: pair.master,
            writer,
            child,
        },
    );
    Ok(id)
}

#[tauri::command]
pub fn terminal_write(
    terminals: tauri::State<'_, TerminalSet>,
    id: String,
    data: Vec<u8>,
) -> Result<(), Error> {
    let mut set = terminals.lock()?;
    let handle = set
        .get_mut(&id)
        .ok_or_else(|| failure("TERMINAL_NOT_FOUND", "终端会话不存在或已关闭。", &id))?;
    handle
        .writer
        .write_all(&data)
        .and_then(|()| handle.writer.flush())
        .map_err(|error| failure("TERMINAL_WRITE_FAILED", "无法写入终端。", error))
}

#[tauri::command]
pub fn terminal_resize(
    terminals: tauri::State<'_, TerminalSet>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), Error> {
    let mut set = terminals.lock()?;
    let handle = set
        .get_mut(&id)
        .ok_or_else(|| failure("TERMINAL_NOT_FOUND", "终端会话不存在或已关闭。", &id))?;
    handle
        .master
        .resize(PtySize {
            rows: rows.clamp(2, 500),
            cols: cols.clamp(2, 500),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| failure("TERMINAL_RESIZE_FAILED", "无法调整终端大小。", error))
}

#[tauri::command]
pub fn terminal_close(terminals: tauri::State<'_, TerminalSet>, id: String) -> Result<(), Error> {
    // 移除即触发 Drop：kill 子进程、关闭 writer，reader 线程随 EOF 结束。
    terminals.lock()?.remove(&id);
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn pty_echo_roundtrip_and_kill() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new("cat");
        command.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();

        writer.write_all(b"proof-pty-ok\n").unwrap();
        writer.flush().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut output = Vec::new();
        let mut buffer = [0u8; 1024];
        while Instant::now() < deadline {
            match reader.read(&mut buffer) {
                Ok(n) if n > 0 => {
                    output.extend_from_slice(&buffer[..n]);
                    if output.windows(12).any(|w| w == b"proof-pty-ok") {
                        break;
                    }
                }
                Ok(_) => std::thread::sleep(Duration::from_millis(10)),
                Err(_) => break,
            }
        }
        assert!(
            output.windows(12).any(|w| w == b"proof-pty-ok"),
            "expected echo, got {:?}",
            String::from_utf8_lossy(&output)
        );

        pair.master
            .resize(PtySize {
                rows: 40,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        child.kill().unwrap();
        let _ = child.wait();
    }
}
