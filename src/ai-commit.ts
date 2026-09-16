import { useEffect, useRef, useState } from "react";
import { asError, useReadRequest } from "./api";
import {
  advanceAiProgress,
  startAiProgress,
  type AiRunProgress,
} from "./ai-progress";
import type { AgentKind, AiReport } from "./ai";
import type { Changes, ProofError } from "./types";

export function useAiCommit(
  changes: Changes,
  provider: AgentKind,
  amend: boolean,
  message: string,
  onMessage: (value: string) => void,
) {
  const reader = useReadRequest();
  const [pending, setPending] = useState<"commit" | null>(null);
  const [progress, setProgress] = useState<AiRunProgress | null>(null);
  const [error, setError] = useState<ProofError | null>(null);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [session, setSession] = useState<AiReport["session"]>(null);
  const generation = useRef(0),
    running = useRef(false);
  const suggestionScope = useRef("");
  const live = useRef({ changes, message, onMessage, amend });
  live.current = { changes, message, onMessage, amend };
  const scopeKey = (value: typeof live.current) =>
    `${value.changes.workspace.id}\0${value.changes.token}\0${value.amend}`;
  useEffect(() => {
    ++generation.current;
    running.current = false;
    setPending(null);
    setProgress(null);
    setSuggestion(null);
    setSession(null);
    setError(null);
    return () => {
      ++generation.current;
      running.current = false;
      reader.cancel();
    };
  }, [changes.workspace.id, changes.token, amend, provider]);

  async function generate() {
    if (running.current) return;
    const current = live.current;
    const scope = scopeKey(current);
    const n = generation.current;
    running.current = true;
    setPending("commit");
    setProgress(startAiProgress());
    setError(null);
    setSuggestion(null);
    try {
      const result = await reader.read<AiReport>(
        "run_ai_task",
        {
          request: {
            task: "commit",
            provider,
            amend: current.amend,
            scope: {
              kind: "local",
              workspaceId: current.changes.workspace.id,
              expectedToken: current.changes.token,
              files: null,
            },
          },
        },
        (event) => {
          if (n === generation.current)
            setProgress((state) =>
              state ? advanceAiProgress(state, event) : state,
            );
        },
      );
      if (n !== generation.current || scope !== scopeKey(live.current)) return;
      setSession(result.session);
      if (result.task !== "commit" || !result.commitMessage?.trim())
        throw {
          code: "AI_INVALID_OUTPUT",
          message: "Agent 返回的结果无法验证，请重试。",
          detail: "Missing commit message",
        };
      if (!current.message.trim() && live.current.message === current.message)
        live.current.onMessage(result.commitMessage);
      else {
        suggestionScope.current = scope;
        setSuggestion(result.commitMessage);
      }
    } catch (e) {
      if (n === generation.current) setError(asError(e));
    } finally {
      if (n === generation.current) {
        running.current = false;
        setPending(null);
      }
    }
  }
  return {
    pending,
    progress,
    error,
    suggestion,
    session,
    generate,
    dismiss: () => setSuggestion(null),
    apply: () => {
      if (suggestion && suggestionScope.current === scopeKey(live.current))
        live.current.onMessage(suggestion);
      setSuggestion(null);
    },
    cancel: () => {
      setProgress((state) => (state ? { ...state, cancelling: true } : state));
      reader.cancel();
    },
  };
}
