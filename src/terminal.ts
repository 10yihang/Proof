// 嵌入式终端会话 API。低内存约定见 docs/TERMINAL-EMBEDDING-OPTIONS.md：
// 输出经 Channel 以二进制下发（ArrayBuffer），关闭即回收 PTY。
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface SpawnTerminalOptions {
  cwd?: string;
  cols: number;
  rows: number;
  onData: (chunk: Uint8Array) => void;
}

export function spawnTerminal(options: SpawnTerminalOptions): Promise<string> {
  const onData = new Channel<ArrayBuffer>();
  onData.onmessage = (message) => {
    // Raw 字节经 Channel 到达为 ArrayBuffer；保留数组兜底以兼容极端运行时。
    options.onData(
      message instanceof ArrayBuffer
        ? new Uint8Array(message)
        : new Uint8Array(message as unknown as number[]),
    );
  };
  return invoke<string>("terminal_spawn", {
    cwd: options.cwd ?? null,
    cols: options.cols,
    rows: options.rows,
    onData,
  });
}

const encoder = new TextEncoder();

export function writeTerminal(id: string, data: string | Uint8Array) {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return invoke("terminal_write", { id, data: Array.from(bytes) });
}

export function resizeTerminal(id: string, cols: number, rows: number) {
  return invoke("terminal_resize", { id, cols, rows });
}

export function closeTerminal(id: string) {
  return invoke("terminal_close", { id }).catch(() => undefined);
}

export function onTerminalExit(id: string, callback: () => void) {
  return listen<{ id: string }>("terminal-exit", (event) => {
    if (event.payload.id === id) callback();
  });
}
