import { Fieldset } from "@base-ui/react/fieldset";
import { Button, Select, Input } from "./ui/controls";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { DropdownMenuItem as MenuItem } from "./ui/dropdown-menu";
import { toast } from "./ui/toast";
import {
  ArrowDown,
  ArrowUp,
  CloudArrowDown,
  DotsThree,
  GitBranch,
  X,
} from "@phosphor-icons/react";
import { asError, useRequest } from "../api";
import { t, uiMessage } from "../i18n";
import { publishDiffEvent } from "../diff-events";
import type { Changes, ProofError } from "../types";
import {
  actionVerbs,
  actionExplanation,
  actionLabel,
  branchRef,
} from "../history-actions";
import type {
  HistoryActionKind,
  HistoryActionPreview,
  HistoryActionRequest,
  HistoryActionResult,
  HistoryRepositoryState,
  HistoryTarget,
} from "../history-actions";
import { Modal } from "./Modal";

export function useHistoryActions(
  changes: Changes,
  demo: boolean,
  onChanged: () => Promise<void>,
  onOpenLocalFile: (path: string) => void,
  historyActive: boolean,
) {
  const request = useRequest();
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<HistoryRepositoryState | null>(null);
  const [stateError, setStateError] = useState<ProofError | null>(null);
  const [action, setAction] = useState<{
    kind: HistoryActionKind;
    target?: HistoryTarget;
    path?: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [result, setResult] = useState<HistoryActionResult | null>(null);
  const fetchOwner = useRef(changes.workspace.id);
  useEffect(() => {
    fetchOwner.current = changes.workspace.id;
    return () => {
      fetchOwner.current = "";
    };
  }, [changes.workspace.id]);
  useEffect(() => {
    if (!historyActive || demo || !changes.workspace.trusted) return;
    const fetch = () => {
      if (document.visibilityState === "hidden" || running.current) return;
      // Reconcile local refs on entry/focus even while network is throttled.
      setRevision((value) => value + 1);
      // The native core owns the per-repository, one-minute throttle. Keeping it
      // there also covers remounts, multiple windows and linked Worktrees.
      void request<boolean>("history_auto_fetch", {
        workspaceId: changes.workspace.id,
      })
        .then((fetched) => {
          if (fetchOwner.current === changes.workspace.id && fetched)
            setRevision((value) => value + 1);
        })
        .catch(() => {
          // Offline/credentials failures are quiet; a partial fetch can still
          // have refreshed refs. Manual Fetch retains its full error feedback.
          if (fetchOwner.current === changes.workspace.id)
            setRevision((value) => value + 1);
        });
    };
    fetch();
    window.addEventListener("focus", fetch);
    document.addEventListener("visibilitychange", fetch);
    return () => {
      window.removeEventListener("focus", fetch);
      document.removeEventListener("visibilitychange", fetch);
    };
  }, [historyActive, demo, changes.workspace.id, changes.workspace.trusted]);
  useEffect(() => {
    if (demo) return;
    let cancelled = false;
    void request<HistoryRepositoryState>("history_repository_state", {
      workspaceId: changes.workspace.id,
    })
      .then((value) => {
        if (!cancelled) {
          setState(value);
          setStateError(null);
        }
      })
      .catch((error) => {
        if (!cancelled) setStateError(asError(error));
      });
    return () => {
      cancelled = true;
    };
  }, [
    changes.workspace.id,
    changes.head,
    changes.branch,
    changes.operation,
    revision,
    demo,
  ]);
  useEffect(() => {
    const changed = (event: Event) => {
      if (
        (event as CustomEvent<{ workspaceId: string }>).detail?.workspaceId ===
        changes.workspace.id
      ) {
        setRevision((value) => value + 1);
        if (!running.current)
          void onChanged().catch((error) => setStateError(asError(error)));
      }
    };
    window.addEventListener("proof:git-updated", changed);
    return () => window.removeEventListener("proof:git-updated", changed);
  }, [changes.workspace.id]);
  function open(
    kind: HistoryActionKind,
    target?: HistoryTarget,
    path?: string,
  ) {
    if (running.current) return;
    setResult(null);
    setAction({ kind, target, path });
  }
  async function copy(value: string, commitMessage = false) {
    try {
      const content = commitMessage
        ? await request<string>("history_commit_message", {
            workspaceId: changes.workspace.id,
            oid: value,
          })
        : value;
      await navigator.clipboard.writeText(content);
      toast.add({ title: t("已复制"), type: "success" });
    } catch (error) {
      toast.add({ title: t("复制失败，请重试。"), type: "error" });
      setStateError(asError(error));
    }
  }
  async function execute(preview: HistoryActionPreview) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const value = await request<HistoryActionResult>(
        "execute_history_action",
        { workspaceId: changes.workspace.id, previewId: preview.id },
      );
      setResult(value);
      setAction(null);
    } finally {
      // Also refresh on a failed or partially completed Git command.
      try {
        await onChanged();
      } catch (error) {
        setStateError(asError(error));
      } finally {
        publishDiffEvent("proof:git-updated", {
          workspaceId: changes.workspace.id,
        });
        running.current = false;
        setBusy(false);
      }
    }
  }
  const disabled = demo || !changes.workspace.trusted || busy;
  return {
    open,
    copy,
    disabled,
    busy,
    revision,
    refresh: () => {
      setRevision((value) => value + 1);
      void onChanged().catch((error) => setStateError(asError(error)));
    },
    state,
    stateError,
    toolbar: (
      <div className="history-git-toolbar" aria-label={t("History Git 操作")}>
        <span className="history-current-branch">
          <GitBranch size={15} />
          {changes.branch ?? "Detached HEAD"}
        </span>
        {state?.upstream && (
          <span className="history-upstream" title={state.upstream}>
            ↑ {state.ahead} ↓ {state.behind}
          </span>
        )}
        <div className="toolbar-spacer" />
        <Button
          className="button compact"
          disabled={disabled || !!changes.operation || !state?.remotes.length}
          onClick={() => open("fetch")}
        >
          <CloudArrowDown size={16} />
          Fetch
        </Button>
        <Button
          className="button compact"
          disabled={
            disabled ||
            !!changes.operation ||
            !changes.branch ||
            !state?.remotes.length
          }
          onClick={() => open("pull")}
        >
          <ArrowDown size={15} />
          Pull
        </Button>
        <Button
          className="button compact"
          disabled={
            disabled ||
            !!changes.operation ||
            !changes.branch ||
            !changes.head ||
            !state?.remotes.length
          }
          onClick={() => open("push")}
        >
          <ArrowUp size={15} />
          Push
        </Button>
        <Button
          className="button compact"
          disabled={disabled || !!changes.operation || !changes.head}
          onClick={() => open("createBranch")}
        >
          <GitBranch size={15} />
          {t("创建 Branch…")}
        </Button>
        {!demo && state && !state.remotes.length && (
          <span className="history-upstream">{t("未配置 Remote")}</span>
        )}
      </div>
    ),
    feedback: (
      <>
        {stateError && (
          <div className="graph-error" role="alert">
            <span>{uiMessage(stateError.message)}</span>
            <Button onClick={() => setRevision((v) => v + 1)}>
              {t("重试")}
            </Button>
          </div>
        )}
        {changes.operation && (
          <div className="history-operation-banner">
            <strong>{t("{v0} 进行中", { v0: changes.operation })}</strong>
            <span>{t("解决冲突并 Stage 后继续，或中止此次操作。")}</span>
            <div className="toolbar-spacer" />
            <Button
              className="button compact"
              disabled={
                disabled ||
                changes.files.some((f) => f.conflicted) ||
                changes.operation === "Bisect"
              }
              onClick={() => open("continue")}
            >
              {t("继续操作")}
            </Button>
            <Button
              className="button compact"
              disabled={disabled || changes.operation === "Bisect"}
              onClick={() => open("abort")}
            >
              {t("中止操作…")}
            </Button>
            {changes.files
              .filter((f) => f.conflicted)
              .map((file) => (
                <div className="history-conflict" key={file.path}>
                  <Button
                    className="history-conflict-path"
                    title={t("在 Local changes 中查看冲突")}
                    onClick={() => onOpenLocalFile(file.path)}
                  >
                    <code>{file.path}</code>
                  </Button>
                  <Button
                    className="button compact"
                    disabled={disabled}
                    onClick={() =>
                      open("stageResolution", undefined, file.path)
                    }
                  >
                    {t("Stage 冲突解决结果")}
                  </Button>
                </div>
              ))}
          </div>
        )}
        {result && (
          <div
            className={`history-operation-result ${result.ok ? "" : "has-error"}`}
            role="status"
          >
            <strong>
              {result.ok
                ? t("Git 操作已完成")
                : result.operation
                  ? t("操作暂停，请解决冲突后继续。")
                  : t("Git 操作未完成")}
            </strong>
            <span>
              {result.branch ?? "Detached HEAD"} · {result.head?.slice(0, 8)}
            </span>
            {result.warning && <p>{uiMessage(result.warning)}</p>}
            {result.detail && (
              <details open={!result.ok}>
                <summary>{t("Git 输出")}</summary>
                <pre>{result.detail}</pre>
              </details>
            )}
            <Button
              className="icon-button"
              aria-label={t("关闭")}
              onClick={() => setResult(null)}
            >
              <X size={14} />
            </Button>
          </div>
        )}
      </>
    ),
    dialog: action && (
      <HistoryActionDialog
        key={`${action.kind}:${action.path ?? ""}`}
        action={action}
        changes={changes}
        state={state}
        busy={busy}
        onClose={() => {
          if (!running.current) setAction(null);
        }}
        onExecute={execute}
      />
    ),
  };
}
export type HistoryActions = ReturnType<typeof useHistoryActions>;

function HistoryActionDialog({
  action,
  changes,
  state,
  busy,
  onClose,
  onExecute,
}: {
  action: { kind: HistoryActionKind; target?: HistoryTarget; path?: string };
  changes: Changes;
  state: HistoryRepositoryState | null;
  busy: boolean;
  onClose: () => void;
  onExecute: (preview: HistoryActionPreview) => Promise<void>;
}) {
  const request = useRequest();
  const { kind, target } = action;
  const remoteBranch = target?.type === "branch" && target.branch.remote;
  const initialRemote =
    state?.upstreamRemote && state.remotes.includes(state.upstreamRemote)
      ? state.upstreamRemote
      : (state?.remotes[0] ?? "");
  const [remote, setRemote] = useState(initialRemote);
  const [name, setName] = useState(
    kind === "pull" || kind === "push"
      ? (state?.upstreamBranch ?? changes.branch ?? "")
      : kind === "renameBranch" && target?.type === "branch"
        ? target.branch.name
        : remoteBranch && target?.type === "branch"
          ? target.branch.name.slice(
              (state?.remotes.find((r) =>
                target.branch.name.startsWith(`${r}/`),
              )?.length ?? target.branch.name.indexOf("/")) + 1,
            )
          : "",
  );
  const [mode, setMode] = useState(kind === "pull" ? "ff-only" : "mixed");
  const [mainline, setMainline] = useState(1);
  const [preview, setPreview] = useState<HistoryActionPreview | null>(null);
  const [error, setError] = useState<ProofError | null>(null);
  const [loading, setLoading] = useState(true);
  const [acknowledged, setAcknowledged] = useState(false);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const named =
    ["createBranch", "renameBranch", "createTag", "pull", "push"].includes(
      kind,
    ) ||
    (kind === "switch" && remoteBranch);
  const network = ["fetch", "pull", "push"].includes(kind);
  const parents = target?.type === "commit" ? target.commit.parents : [];
  const label =
    target?.type === "branch"
      ? target.branch.name
      : target?.type === "commit"
        ? target.commit.subject
        : (action.path ?? changes.branch ?? "HEAD");
  const requestTarget =
    action.path ??
    (target?.type === "branch"
      ? branchRef(target.branch)
      : target?.type === "commit"
        ? target.commit.oid
        : (changes.head ?? undefined));
  useEffect(() => {
    const current = ++generation.current;
    setPreview(null);
    setError(null);
    setLoading(true);
    setAcknowledged(false);
    if ((named && !name) || (network && !remote)) {
      setLoading(false);
      return;
    }
    const timer = setTimeout(() => {
      const value: HistoryActionRequest = { kind, target: requestTarget };
      if (named) value.name = name;
      if (network) value.remote = remote;
      if (kind === "pull" || kind === "reset") value.mode = mode;
      if ((kind === "cherryPick" || kind === "revert") && parents.length > 1)
        value.mainline = mainline;
      void request<HistoryActionPreview>("prepare_history_action", {
        workspaceId: changes.workspace.id,
        request: value,
        expectedToken: changes.token,
      })
        .then((value) => {
          if (generation.current === current) setPreview(value);
        })
        .catch((error) => {
          if (generation.current === current) setError(asError(error));
        })
        .finally(() => {
          if (generation.current === current) setLoading(false);
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      generation.current++;
    };
  }, [
    kind,
    requestTarget,
    name,
    remote,
    mode,
    mainline,
    changes.token,
    changes.workspace.id,
    retry,
    named,
    network,
    parents.length,
  ]);
  const source = ["merge", "pull", "cherryPick", "revert"].includes(kind)
    ? network
      ? `${remote}/${name}`
      : label
    : (changes.branch ?? "Detached HEAD");
  const destination = ["merge", "pull", "cherryPick", "revert"].includes(kind)
    ? (changes.branch ?? "Detached HEAD")
    : network
      ? `${remote}/${name}`
      : label;
  return (
    <Modal
      title={actionLabel(kind)}
      error={error}
      onClose={onClose}
      dismissible={!busy}
      className="history-action-dialog"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (preview && !busy && (!preview.destructive || acknowledged))
            void onExecute(preview).catch((error) => {
              setError(asError(error));
              setPreview(null);
            });
        }}
      >
        <Fieldset.Root disabled={busy}>
          <div className="history-action-direction">
            <span>{source}</span>
            <span>→</span>
            <strong title={destination}>{destination}</strong>
          </div>
          <p className="history-action-help">{actionExplanation(kind, mode)}</p>
          {network && (
            <label className="field-label">
              Remote
              <Select
                aria-label="Remote"
                value={remote}
                onChange={(e) => setRemote(e.target.value)}
              >
                {state?.remotes.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </Select>
            </label>
          )}
          {named && (
            <label className="field-label">
              {kind === "createTag"
                ? t("Tag 名称")
                : kind === "pull" || kind === "push"
                  ? t("远程 Branch")
                  : t("Branch 名称")}
              <Input
                autoFocus
                aria-label={
                  kind === "createTag"
                    ? t("Tag 名称")
                    : kind === "pull" || kind === "push"
                      ? t("远程 Branch")
                      : t("Branch 名称")
                }
                value={name}
                onChange={(e) => setName(e.target.value)}
                spellCheck={false}
              />
            </label>
          )}
          {kind === "pull" && (
            <label className="field-label">
              {t("Pull 方式")}
              <Select
                aria-label={t("Pull 方式")}
                value={mode}
                onChange={(e) => setMode(e.target.value)}
              >
                <option value="ff-only">Fast-forward only</option>
                <option value="merge">Merge</option>
                <option value="rebase">Rebase</option>
              </Select>
            </label>
          )}
          {kind === "reset" && (
            <label className="field-label">
              {t("Reset 方式")}
              <Select
                aria-label={t("Reset 方式")}
                value={mode}
                onChange={(e) => setMode(e.target.value)}
              >
                <option value="soft">Soft</option>
                <option value="mixed">Mixed</option>
                <option value="hard">Hard</option>
              </Select>
            </label>
          )}
          {(kind === "cherryPick" || kind === "revert") &&
            parents.length > 1 && (
              <label className="field-label">
                {t("Mainline Parent")}
                <Select
                  aria-label={t("Mainline Parent")}
                  value={mainline}
                  onChange={(e) => setMainline(Number(e.target.value))}
                >
                  {parents.map((oid, index) => (
                    <option key={oid} value={index + 1}>
                      Parent {index + 1} · {oid.slice(0, 8)}
                    </option>
                  ))}
                </Select>
              </label>
            )}
          <div className="history-action-preview" aria-live="polite">
            {loading ? (
              <span>{t("正在检查 Git 状态…")}</span>
            ) : (
              preview && (
                <>
                  <dl>
                    <dt>HEAD</dt>
                    <dd>
                      <code>{preview.head?.slice(0, 12) ?? "—"}</code>
                    </dd>
                    {preview.targetOid && (
                      <>
                        <dt>{t("目标 Commit")}</dt>
                        <dd>
                          <code>{preview.targetOid.slice(0, 12)}</code>
                        </dd>
                      </>
                    )}
                    <dt>{t("本地修改")}</dt>
                    <dd>{preview.dirtyFiles}</dd>
                    {preview.affectedCommits > 0 && (
                      <>
                        <dt>Commits</dt>
                        <dd>{preview.affectedCommits}</dd>
                      </>
                    )}
                  </dl>
                  <details>
                    <summary>{t("Git 命令")}</summary>
                    <code>
                      git{" "}
                      {preview.arguments
                        .map((arg) =>
                          /[\s"'\\]/.test(arg) ? JSON.stringify(arg) : arg,
                        )
                        .join(" ")}
                    </code>
                  </details>
                </>
              )
            )}
          </div>
          {preview?.destructive && (
            <label className="history-action-ack">
              <Input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              {kind === "reset" && mode === "hard"
                ? t("我确认丢弃受影响的本地修改。")
                : t("我已确认操作目标和影响。")}
            </label>
          )}
          <div className="modal-actions">
            <Button type="button" className="button" onClick={onClose}>
              {t("取消")}
            </Button>
            {error && (
              <Button
                type="button"
                className="button"
                onClick={() => setRetry((v) => v + 1)}
              >
                {t("重新检查")}
              </Button>
            )}
            <Button
              type="submit"
              className={`button ${preview?.destructive ? "danger" : "primary"}`}
              disabled={
                !preview || loading || (!!preview.destructive && !acknowledged)
              }
            >
              {busy
                ? t("Git 操作进行中…")
                : t("执行 {v0}", { v0: actionVerbs[kind] })}
            </Button>
          </div>
        </Fieldset.Root>
      </form>
    </Modal>
  );
}

export function GitContextMenu({
  x,
  y,
  onClose,
  children,
  label,
}: {
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
  label: string;
}) {
  const popup = useRef<HTMLDivElement>(null);
  const focused = useRef(document.activeElement as HTMLElement | null);
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() =>
      popup.current
        ?.querySelector<HTMLElement>("[role=menuitem]:not([data-disabled])")
        ?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, []);
  const anchor = useMemo(
    () => ({ getBoundingClientRect: () => new DOMRect(x, y, 0, 0) }),
    [x, y],
  );
  return (
    <Menu.Root
      open
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <Menu.Portal>
        <Menu.Positioner
          anchor={anchor}
          side="bottom"
          align="start"
          sideOffset={0}
          collisionPadding={8}
          className="z-[230] outline-none"
        >
          <Menu.Popup
            ref={popup}
            className="history-git-menu proof-menu max-h-(--available-height) min-w-64 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl outline-none"
            aria-label={label}
            finalFocus={() =>
              focused.current?.isConnected ? focused.current : true
            }
          >
            {children}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function HistoryTargetActions({
  target,
  actions,
  changes,
  onClose,
}: {
  target: HistoryTarget;
  actions: HistoryActions;
  changes: Changes;
  onClose: () => void;
}) {
  const branch = target.type === "branch" ? target.branch : null;
  const items: HistoryActionKind[] = branch
    ? [
        "switch",
        "createBranch",
        "merge",
        "rebase",
        ...(!branch.remote ? (["renameBranch", "deleteBranch"] as const) : []),
      ]
    : [
        "checkoutCommit",
        "createBranch",
        "createTag",
        "cherryPick",
        "revert",
        "rebase",
        "reset",
      ];
  return (
    <>
      <div className="history-menu-label">
        {branch?.name ??
          (target.type === "commit" ? target.commit.oid.slice(0, 8) : "")}
      </div>
      {items.map((kind) => (
        <MenuItem
          role="menuitem"
          key={kind}
          disabled={
            actions.disabled ||
            !!changes.operation ||
            ((kind === "switch" ||
              kind === "deleteBranch" ||
              kind === "merge" ||
              kind === "rebase") &&
              !!branch?.current) ||
            (!changes.branch &&
              ["merge", "rebase", "cherryPick", "revert", "reset"].includes(
                kind,
              )) ||
            (!!branch?.remote && branch.name.endsWith("/HEAD"))
          }
          onClick={() => {
            actions.open(kind, target);
            onClose();
          }}
        >
          {actionLabel(kind)}
        </MenuItem>
      ))}
      <hr />
      <MenuItem
        role="menuitem"
        onClick={() => {
          void actions.copy(
            branch?.name ?? (target.type === "commit" ? target.commit.oid : ""),
          );
          onClose();
        }}
      >
        {branch ? t("复制 Branch 名称") : t("复制 Commit SHA")}
      </MenuItem>
      {target.type === "commit" && (
        <MenuItem
          role="menuitem"
          disabled={false}
          onClick={() => {
            void actions.copy(target.commit.oid, true);
            onClose();
          }}
        >
          {t("复制 Commit message")}
        </MenuItem>
      )}
      <hr />
    </>
  );
}
export function HistoryMoreButton({
  onClick,
  label,
}: {
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  label: string;
}) {
  return (
    <Button
      className="icon-button history-more-button"
      aria-label={label}
      title={label}
      aria-haspopup="menu"
      onClick={onClick}
    >
      <DotsThree size={18} weight="bold" />
    </Button>
  );
}
