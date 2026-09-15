import { useEffect, useRef, useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import {
  CaretDown,
  GitBranch,
  Check,
  MagnifyingGlass,
  Plus,
  Globe,
  ArrowClockwise,
} from "@phosphor-icons/react";
import { Button } from "./ui/controls";
import { t, uiMessage } from "../i18n";
import { asError, useRequest } from "../api";
import { demoGraphPage } from "../graph-demo";
import type { BranchEntry, Changes, ProofError } from "../types";
import { branchRef } from "../history-actions";

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
  const [error, setError] = useState<ProofError | null>(null),
    [revision, setRevision] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const selecting = useRef(false);
  useEffect(() => {
    if (!opened) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (
      demo
        ? Promise.resolve(demoGraphPage().branches)
        : request<BranchEntry[]>("branches", {
            workspaceId: changes.workspace.id,
          })
    )
      .then((value) => {
        if (!cancelled) setBranches(value);
      })
      .catch((error) => {
        if (!cancelled) setError(asError(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    opened,
    changes.workspace.id,
    changes.head,
    changes.branch,
    demo,
    revision,
  ]);
  async function select(branch: BranchEntry) {
    if (selecting.current || busy) return;
    if (branch.current) {
      setOpened(false);
      return;
    }
    if (demo || !changes.workspace.trusted) return;
    selecting.current = true;
    try {
      const name = branch.remote
        ? branch.name.slice(branch.name.indexOf("/") + 1)
        : branch.name;
      const local = branch.remote
        ? branches.find((b) => !b.remote && b.name === name)
        : null;
      if (
        await onSwitch(
          local?.name ?? name,
          branch.remote && !local,
          branch.remote && !local ? branch.name : undefined,
        )
      )
        setOpened(false);
    } finally {
      selecting.current = false;
    }
  }
  const matches = branches.filter((branch) =>
    branch.name.toLowerCase().includes(search.toLowerCase()),
  );
  const items = matches.map(branchRef);
  return (
    <Combobox.Root<string>
      items={items}
      filter={null}
      open={opened}
      value={
        branches.find((b) => b.current)
          ? branchRef(branches.find((b) => b.current)!)
          : null
      }
      inputValue={search}
      onInputValueChange={setSearch}
      onOpenChange={(open, details) => {
        if (details.reason === "item-press" || selecting.current) {
          details.cancel();
          return;
        }
        setOpened(open);
        if (open) setSearch("");
      }}
      onValueChange={(value) => {
        const branch = branches.find((b) => branchRef(b) === value);
        if (branch) void select(branch);
      }}
      itemToStringLabel={(value) =>
        branches.find((b) => branchRef(b) === value)?.name ?? value
      }
    >
      <Combobox.Trigger
        render={
          <Button
            className="branch-picker"
            disabled={busy}
            aria-label={t("切换 Branch，当前 {v0}", {
              v0: changes.branch ?? "Detached HEAD",
            })}
          />
        }
      >
        <GitBranch size={15} />
        <span>{changes.branch ?? "Detached HEAD"}</span>
        <CaretDown size={11} />
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          className="z-[230]"
        >
          <Combobox.Popup
            initialFocus={input}
            aria-label={t("Switch branch")}
            className="proof-branch-popup w-80 origin-(--transform-origin) overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl outline-none duration-150 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:opacity-0"
          >
            <div className="flex h-11 items-center gap-2 border-b border-border px-3 text-muted-foreground">
              <MagnifyingGlass size={16} />
              <Combobox.Input
                ref={input}
                className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[12px] text-foreground outline-none shadow-none focus:ring-0"
                aria-label={t("搜索 Branch")}
                placeholder={t("Find or create a branch…")}
              />
            </div>
            {loading && (
              <div className="branch-empty flex gap-2">
                <ArrowClockwise className="spinning" size={14} />
                {t("载入 Branch…")}
              </div>
            )}
            {error && (
              <div className="branch-empty" role="alert">
                {uiMessage(error.message)}
                <Button
                  className="text-button"
                  onClick={() => setRevision((value) => value + 1)}
                >
                  {t("重试")}
                </Button>
              </div>
            )}
            <Combobox.List
              className="max-h-80 overflow-y-auto p-1"
              aria-label={t("分支")}
            >
              {matches.map((branch, index) => (
                <div key={branchRef(branch)}>
                  {(index === 0 ||
                    matches[index - 1].remote !== branch.remote) && (
                    <div className="px-2 py-2 text-[10px] font-medium text-muted-foreground">
                      {branch.remote
                        ? t("Remote branches")
                        : t("Local branches")}
                    </div>
                  )}
                  <Combobox.Item
                    value={branchRef(branch)}
                    className="branch-option flex min-h-8 items-center gap-2 rounded-md px-2 py-1.5 text-[12px] outline-none data-highlighted:bg-accent data-disabled:opacity-40"
                    disabled={
                      busy ||
                      loading ||
                      (!branch.current && (demo || !changes.workspace.trusted))
                    }
                  >
                    {branch.remote ? (
                      <Globe size={14} />
                    ) : (
                      <GitBranch size={14} />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      {branch.name}
                    </span>
                    {branch.current ? (
                      <Check size={14} />
                    ) : (
                      <code className="text-[10px] text-muted-foreground">
                        {branch.oid.slice(0, 7)}
                      </code>
                    )}
                  </Combobox.Item>
                </div>
              ))}
              {!loading && !matches.length && (
                <Combobox.Empty className="branch-empty">
                  {t("没有匹配的 Branch")}
                </Combobox.Empty>
              )}
            </Combobox.List>
            {search.trim() &&
              !branches.some((b) => !b.remote && b.name === search.trim()) && (
                <Button
                  className="branch-option create-branch w-full border-t border-border px-3 py-2 text-[12px]"
                  disabled={
                    busy || loading || demo || !changes.workspace.trusted
                  }
                  onClick={() =>
                    void onSwitch(search.trim(), true).then((ok) => {
                      if (ok) setOpened(false);
                    })
                  }
                >
                  <Plus size={15} />
                  <span>
                    {t("Create branch “")}
                    {search.trim()}”
                  </span>
                </Button>
              )}
            {(demo || !changes.workspace.trusted) && (
              <p className="branch-empty">
                {demo
                  ? t("Demo · Git 操作在桌面应用中可用")
                  : t("信任仓库后可切换 Branch")}
              </p>
            )}
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
