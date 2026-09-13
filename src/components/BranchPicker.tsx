import { useEffect, useRef, useState } from "react";
import {
  CaretDown,
  GitBranch,
  Check,
  MagnifyingGlass,
  Plus,
  Globe,
  ArrowClockwise,
} from "@phosphor-icons/react";
import { asError, useRequest } from "../api";
import { demoGraphPage } from "../graph-demo";
import type { BranchEntry, Changes, ProofError } from "../types";

export function BranchPicker({
  changes,
  demo,
  busy,
  onSwitch,
}: {
  changes: Changes;
  demo: boolean;
  busy: boolean;
  onSwitch: (
    name: string,
    create: boolean,
    remote?: string,
  ) => Promise<boolean>;
}) {
  const request = useRequest();
  const [opened, setOpened] = useState(false),
    [search, setSearch] = useState("");
  const [branches, setBranches] = useState<BranchEntry[]>([]),
    [loading, setLoading] = useState(false);
  const [error, setError] = useState<ProofError | null>(null);
  const root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    input = useRef<HTMLInputElement>(null);
  function close() {
    setOpened(false);
    trigger.current?.focus();
  }
  useEffect(() => {
    if (!opened) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    input.current?.focus();
    void (
      demo
        ? Promise.resolve(demoGraphPage().branches)
        : request<BranchEntry[]>("branches", {
            workspaceId: changes.workspace.id,
          })
    )
      .then((result) => {
        if (!cancelled) setBranches(result);
      })
      .catch((error) => {
        if (!cancelled) setError(asError(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpened(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => {
      cancelled = true;
      document.removeEventListener("pointerdown", outside);
    };
  }, [opened, changes.workspace.id, changes.head, changes.branch, demo]);
  const matches = branches.filter((branch) =>
    branch.name.toLowerCase().includes(search.toLowerCase()),
  );
  async function select(branch: BranchEntry) {
    if (branch.current) {
      close();
      return;
    }
    let name = branch.name;
    if (branch.remote) {
      name = name.slice(name.indexOf("/") + 1);
      const local = branches.find(
        (candidate) => !candidate.remote && candidate.name === name,
      );
      if (local) {
        if (await onSwitch(local.name, false)) close();
        return;
      }
    }
    if (
      await onSwitch(
        name,
        branch.remote,
        branch.remote ? branch.name : undefined,
      )
    )
      close();
  }
  return (
    <div
      className="branch-switcher"
      ref={root}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const options = [
            ...(root.current?.querySelectorAll<HTMLButtonElement>(
              ".branch-option:not(:disabled)",
            ) ?? []),
          ];
          const index = options.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          options[
            Math.max(
              0,
              Math.min(
                options.length - 1,
                index + (event.key === "ArrowDown" ? 1 : -1),
              ),
            )
          ]?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        className="branch-picker"
        aria-label={`切换 Branch，当前 ${changes.branch ?? "Detached HEAD"}`}
        aria-haspopup="dialog"
        aria-expanded={opened}
        disabled={busy}
        onClick={() => {
          setOpened(!opened);
          setSearch("");
        }}
      >
        <GitBranch size={15} />
        <span>{changes.branch ?? "Detached HEAD"}</span>
        <CaretDown size={11} />
      </button>
      {opened && (
        <div
          className="branch-popover"
          role="dialog"
          aria-label="Switch branch"
        >
          <div className="branch-search">
            <MagnifyingGlass size={16} />
            <input
              ref={input}
              aria-label="搜索 Branch"
              placeholder="Find or create a branch…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229)
                  return;
                if (
                  event.key === "Enter" &&
                  matches.length === 1 &&
                  !busy &&
                  !demo &&
                  changes.workspace.trusted
                )
                  void select(matches[0]);
              }}
            />
          </div>
          <div className="branch-options">
            {loading && (
              <div className="branch-empty">
                <ArrowClockwise className="spinning" size={14} />
                载入 Branch…
              </div>
            )}
            {error && (
              <p role="alert" className="branch-empty">
                {error.message}
                <button
                  onClick={() => {
                    setOpened(false);
                    requestAnimationFrame(() => setOpened(true));
                  }}
                >
                  重试
                </button>
              </p>
            )}
            {(["local", "remote"] as const).map((group) => (
              <div key={group}>
                {matches.some(
                  (branch) => branch.remote === (group === "remote"),
                ) && (
                  <div className="branch-section-label">
                    {group === "local" ? "Local branches" : "Remote branches"}
                  </div>
                )}
                {matches
                  .filter((branch) => branch.remote === (group === "remote"))
                  .map((branch) => (
                    <button
                      className="branch-option"
                      key={`${group}:${branch.name}`}
                      disabled={
                        busy ||
                        loading ||
                        (!branch.current &&
                          (demo || !changes.workspace.trusted))
                      }
                      title={
                        branch.remote
                          ? `Checkout ${branch.name} as a local branch`
                          : `Switch to ${branch.name}`
                      }
                      onClick={() => void select(branch)}
                    >
                      {branch.remote ? (
                        <Globe size={15} />
                      ) : (
                        <GitBranch size={15} />
                      )}
                      <span>{branch.name}</span>
                      {branch.current ? (
                        <Check size={15} />
                      ) : (
                        <code>{branch.oid.slice(0, 7)}</code>
                      )}
                    </button>
                  ))}
              </div>
            ))}
            {!loading && !matches.length && (
              <p className="branch-empty">没有匹配的 Branch</p>
            )}
          </div>
          {search.trim() &&
            !branches.some(
              (branch) => !branch.remote && branch.name === search.trim(),
            ) && (
              <button
                className="branch-option create-branch"
                disabled={busy || loading || demo || !changes.workspace.trusted}
                onClick={() =>
                  void onSwitch(search.trim(), true).then((ok) => {
                    if (ok) close();
                  })
                }
              >
                <Plus size={15} />
                <span>Create branch “{search.trim()}”</span>
              </button>
            )}
          {(demo || !changes.workspace.trusted) && (
            <p className="branch-empty">
              {demo
                ? "Demo · Git 操作在桌面应用中可用"
                : "信任仓库后可切换 Branch"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
