// Synthetic IPC around the real EditorView; no real files, Git or Agent processes.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { UIProvider } from "../../../src/components/ui/provider";
import "../../../src/styles/theme.css";
import "../../../src/styles/application.css";

const w = window as any;
const callbacks = new Map<number, (event: unknown) => void>();
const listeners = new Map<number, { event: string; callback: number }>();
let id = 0;
const data: Record<string, Record<string, string>> = {
  alpha: { "code.txt": "original alpha\n", "other.txt": "other alpha\n" },
  beta: { "code.txt": "original beta\n" },
};
const stats: Record<
  string,
  { calls: number; active: number; maxActive: number }
> = {};
const held = new Map<string, (() => void)[]>();
const holdNext = new Set<string>();
const failNext = new Set<string>();
w.editorFixture = {
  stats,
  failNext: (command: string) => failNext.add(command),
  holdNext: (command: string) => holdNext.add(command),
  held: (command: string) => held.get(command)?.length ?? 0,
  release: (command: string) => held.get(command)?.shift()?.(),
  write: (workspace: string, path: string, text: string) =>
    (data[workspace][path] = text),
  value: (workspace: string, path: string) => data[workspace][path],
  invalidate(workspace = "alpha") {
    for (const { event, callback } of listeners.values())
      if (event === "workspace-invalidated")
        callbacks.get(callback)?.({ event, payload: workspace });
  },
  visibility(hidden: boolean) {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => hidden,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  },
};
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener: (_event: string, eventId: number) =>
    listeners.delete(eventId),
};
w.__TAURI_INTERNALS__ = {
  transformCallback(callback: (event: unknown) => void) {
    callbacks.set(++id, callback);
    return id;
  },
  async invoke(name: string, payload: any = {}) {
    if (name === "plugin:event|listen") {
      listeners.set(++id, { event: payload.event, callback: payload.handler });
      return id;
    }
    if (name.startsWith("plugin:event|")) return;
    const { command, args } = payload;
    if (command === "data_session")
      return { epoch: 0, wipeEpoch: 0, deletedWorkspaceIds: [] };
    const metric = (stats[command] ??= { calls: 0, active: 0, maxActive: 0 });
    const shouldFail = failNext.delete(command);
    metric.calls++;
    metric.active++;
    metric.maxActive = Math.max(metric.maxActive, metric.active);
    try {
      let result;
      if (command === "list_files")
        result = Object.keys(data[args.workspaceId]).sort();
      else if (command === "read_text_file") {
        const content = data[args.workspaceId][args.path];
        result = {
          workspaceId: args.workspaceId,
          path: args.path,
          content,
          fingerprint: content,
          revision: null,
          size: content.length,
          editable: true,
          eol: "lf",
        };
      } else if (command === "save_text_file") {
        if (
          args.expectedFingerprint !== null &&
          args.expectedFingerprint !== data[args.workspaceId][args.path]
        )
          throw {
            code: "STALE_CONTENT",
            message: "File changed",
            detail: "fixture",
          };
        data[args.workspaceId][args.path] = args.content;
        result = {
          path: args.path,
          fingerprint: args.content,
          size: args.content.length,
        };
      } else if (command === "history") result = [];
      else throw new Error(`Unexpected fixture command ${command}`);
      // Hold completed native results, so tests can reproduce stale IPC arrivals.
      if (holdNext.delete(command))
        await new Promise<void>((resolve) => {
          const queue = held.get(command) ?? [];
          queue.push(resolve);
          held.set(command, queue);
        });
      if (shouldFail) throw new Error("Transient fixture read failure");
      return result;
    } finally {
      metric.active--;
    }
  },
};
const { EditorView } = await import("../../../src/components/EditorView");
const { monaco } = await import("../../../src/monaco-runtime");
w.editorFixture.models = () => monaco.editor.getModels();
function Harness() {
  const [active, setActive] = useState(true);
  const [workspaceId, setWorkspace] = useState("alpha");
  w.editorFixture.activate = setActive;
  w.editorFixture.workspace = setWorkspace;
  return (
    <div
      style={{ height: 800, width: 1300, display: active ? "block" : "none" }}
    >
      <EditorView
        workspaceId={workspaceId}
        active={active}
        trusted
        fontSize={12}
        changedFiles={[]}
        onChanged={() => {}}
      />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <UIProvider>
      <Harness />
    </UIProvider>
  </React.StrictMode>,
);
