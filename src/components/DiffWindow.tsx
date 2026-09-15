import { Button } from "./ui/controls";
import { t, uiMessage } from "../i18n";
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "../App";
import { asError, useRequest } from "../api";
import type { ProofError, Side } from "../types";

type Selection =
  | {
      kind: "comparison";
      workspaceId: string;
      base: string;
      target: string;
      path: string | null;
    }
  | { kind: "local"; workspaceId: string; path: string; side: Side };

export function DiffWindow() {
  const request = useRequest();
  const [selection, setSelection] = useState<Selection | null>(null);
  const [error, setError] = useState<ProofError | null>(null);
  useEffect(() => {
    let active = true;
    void request<{ selection: Selection }>("diff_window_context")
      .then((context) => {
        if (active) setSelection(context.selection);
      })
      .catch((error) => {
        if (active) setError(asError(error));
      });
    return () => {
      active = false;
    };
  }, [request]);
  if (selection)
    return (
      <App
        diffWindow
        initialWorkspaceId={selection.workspaceId}
        initialFile={
          selection.kind === "local"
            ? { path: selection.path, side: selection.side }
            : undefined
        }
        initialComparison={
          selection.kind === "comparison"
            ? {
                base: selection.base,
                target: selection.target,
                path: selection.path ?? undefined,
              }
            : undefined
        }
      />
    );
  return (
    <main className="diff-window-loading">
      <header data-tauri-drag-region>{t("Proof · Diff")}</header>
      {error ? (
        <div role="alert">
          <p>{uiMessage(error.message)}</p>
          <Button
            className="button"
            onClick={() => {
              void getCurrentWindow()
                .close()
                .catch((error) => setError(asError(error)));
            }}
          >
            {t("关闭窗口")}
          </Button>
        </div>
      ) : (
        <p role="status">{t("正在打开 Diff…")}</p>
      )}
    </main>
  );
}
