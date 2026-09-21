import { useEffect, useRef, useState } from "react";
import { ArrowCounterClockwise, X } from "@phosphor-icons/react";
import type { Terminal as XTermTerminal, ITheme } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { t } from "../i18n";
import { uiMessage } from "../i18n";
import { isDesktop } from "../api";
import {
  closeTerminal,
  onTerminalExit,
  resizeTerminal,
  spawnTerminal,
  writeTerminal,
} from "../terminal";
import { Button } from "./ui/controls";

// xterm 与样式按需加载：未打开过终端时主包不携带这部分体积。
interface XtermBundle {
  Terminal: typeof XTermTerminal;
  FitAddon: typeof FitAddon;
}
let bundlePromise: Promise<XtermBundle> | undefined;
function loadXterm(): Promise<XtermBundle> {
  return (bundlePromise ??= Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/xterm/css/xterm.css"),
  ]).then(([core, fit]) => ({
    Terminal: core.Terminal,
    FitAddon: fit.FitAddon,
  })));
}

function terminalTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    background: read("--bg", "#1b1c20"),
    foreground: read("--text", "#e7e8ed"),
    cursor: read("--accent", "#8bb8fa"),
    selectionBackground: read("--accent-soft", "#293951"),
  };
}

type Status = "idle" | "starting" | "running" | "exited" | "failed";

export function TerminalDrawer({
  open,
  workspacePath,
  onClose,
}: {
  open: boolean;
  workspacePath?: string;
  onClose: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTermTerminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const session = useRef<string | null>(null);
  const disposed = useRef(false);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);
  const [mounted, setMounted] = useState(false);

  // 首次打开才挂载并重载，此后保留会话，仅隐藏。
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  useEffect(() => {
    if (!mounted || !isDesktop) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    disposed.current = false;
    (async () => {
      setStatus("starting");
      let bundle: XtermBundle;
      try {
        bundle = await loadXterm();
      } catch (cause) {
        if (!cancelled) {
          setError(String(cause));
          setStatus("failed");
        }
        return;
      }
      if (cancelled || !host.current) return;
      const terminal = new bundle.Terminal({
        scrollback: 2000,
        fontSize: 12.5,
        fontFamily:
          getComputedStyle(document.documentElement)
            .getPropertyValue("--font-mono")
            .trim() || "SFMono-Regular, Menlo, Consolas, monospace",
        cursorBlink: true,
        theme: terminalTheme(),
      });
      const fitAddon = new bundle.FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(host.current);
      fitAddon.fit();
      term.current = terminal;
      fit.current = fitAddon;
      try {
        const id = await spawnTerminal({
          cwd: workspacePath,
          cols: terminal.cols,
          rows: terminal.rows,
          onData: (chunk) => terminal.write(chunk),
        });
        if (disposed.current) {
          void closeTerminal(id);
          return;
        }
        session.current = id;
        terminal.onData((data) => void writeTerminal(id, data));
        terminal.onResize(
          ({ cols, rows }) => void resizeTerminal(id, cols, rows),
        );
        unlisten = await onTerminalExit(id, () => {
          session.current = null;
          setStatus("exited");
          terminal.write(`\r\n\x1b[2m${t("终端进程已退出。")}\x1b[0m\r\n`);
        });
        setStatus("running");
        terminal.focus();
      } catch (cause) {
        if (!cancelled) {
          const failure = cause as { message?: string };
          setError(uiMessage(failure?.message ?? String(cause)));
          setStatus("failed");
        }
      }
    })();
    return () => {
      cancelled = true;
      disposed.current = true;
      unlisten?.();
      if (session.current) {
        void closeTerminal(session.current);
        session.current = null;
      }
      term.current?.dispose();
      term.current = null;
      fit.current = null;
    };
    // generation 变化即“重新启动”：整体重建会话与实例。
  }, [mounted, workspacePath, generation]);

  // 打开/尺寸变化时重新 fit（隐藏状态下 fit 会得到错误尺寸，故仅在 open 时执行）。
  useEffect(() => {
    if (!open || status !== "running") return;
    const element = host.current;
    if (!element) return;
    const refit = () => {
      if (!host.current || host.current.offsetParent === null) return;
      fit.current?.fit();
    };
    const frame = requestAnimationFrame(refit);
    const observer = new ResizeObserver(refit);
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [open, status]);

  function restart() {
    setError("");
    setStatus("idle");
    setGeneration((value) => value + 1);
  }

  if (!mounted || !isDesktop) return null;
  return (
    <section
      id="terminal-drawer"
      className="terminal-drawer"
      hidden={!open}
      aria-label={t("终端")}
    >
      <div className="terminal-drawer-header">
        <span className="terminal-drawer-title">{t("终端")}</span>
        {status === "exited" && (
          <span className="terminal-drawer-status">{t("进程已退出")}</span>
        )}
        {status === "failed" && (
          <span className="terminal-drawer-status error" title={error}>
            {t("终端启动失败")}
          </span>
        )}
        <span className="toolbar-spacer" />
        {(status === "exited" || status === "failed") && (
          <Button
            className="button subtle compact"
            onClick={restart}
            title={t("重新启动终端")}
          >
            <ArrowCounterClockwise size={14} />
            {t("重新启动")}
          </Button>
        )}
        <Button
          className="icon-button"
          aria-label={t("关闭终端")}
          title={t("关闭终端")}
          onClick={onClose}
        >
          <X size={15} />
        </Button>
      </div>
      <div className="terminal-drawer-body" ref={host} />
    </section>
  );
}
