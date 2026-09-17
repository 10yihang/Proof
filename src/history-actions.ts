import type { BranchEntry, CommitEntry } from "./types";
import { t } from "./i18n";

export type HistoryActionKind =
  | "switch"
  | "createBranch"
  | "renameBranch"
  | "deleteBranch"
  | "createTag"
  | "merge"
  | "rebase"
  | "cherryPick"
  | "revert"
  | "reset"
  | "checkoutCommit"
  | "fetch"
  | "pull"
  | "push"
  | "stash"
  | "stashApply"
  | "stashPop"
  | "stashDrop"
  | "continue"
  | "abort"
  | "stageResolution";
export type HistoryTarget =
  | { type: "branch"; branch: BranchEntry }
  | { type: "commit"; commit: CommitEntry };
export interface HistoryActionRequest {
  kind: HistoryActionKind;
  target?: string;
  name?: string;
  remote?: string;
  mode?: string;
  mainline?: number;
}
export interface HistoryActionPreview {
  id: string;
  request: HistoryActionRequest;
  head: string | null;
  branch: string | null;
  targetOid: string | null;
  remoteBranch: string | null;
  expectedRemoteOid: string | null;
  dirtyFiles: number;
  affectedCommits: number;
  operation: string | null;
  arguments: string[];
  destructive: boolean;
}
export interface HistoryActionResult {
  ok: boolean;
  head: string | null;
  branch: string | null;
  operation: string | null;
  conflicts: string[];
  detail: string;
  warning: string | null;
}
export interface HistoryRepositoryState {
  remotes: string[];
  upstream: string | null;
  upstreamRemote: string | null;
  upstreamBranch: string | null;
  ahead: number;
  behind: number;
  operation: string | null;
  conflicts: string[];
}
export interface StashEntry {
  selector: string;
  oid: string;
  subject: string;
  createdAt: number;
}
export function branchRef(branch: BranchEntry) {
  return `refs/${branch.remote ? "remotes" : "heads"}/${branch.name}`;
}
export const actionVerbs: Record<HistoryActionKind, string> = {
  switch: "Switch",
  createBranch: "Branch",
  renameBranch: "Rename",
  deleteBranch: "Delete",
  createTag: "Tag",
  merge: "Merge",
  rebase: "Rebase",
  cherryPick: "Cherry-pick",
  revert: "Revert",
  reset: "Reset",
  checkoutCommit: "Checkout",
  fetch: "Fetch",
  pull: "Pull",
  push: "Push",
  stash: "Stash",
  stashApply: "Apply Stash",
  stashPop: "Pop Stash",
  stashDrop: "Drop Stash",
  continue: "Continue",
  abort: "Abort",
  stageResolution: "Stage",
};
export function actionLabel(kind: HistoryActionKind) {
  switch (kind) {
    case "switch":
      return t("Switch Branch");
    case "createBranch":
      return t("创建 Branch…");
    case "renameBranch":
      return t("重命名 Branch…");
    case "deleteBranch":
      return t("删除 Branch…");
    case "createTag":
      return t("创建 Tag…");
    case "merge":
      return t("Merge 到当前 Branch…");
    case "rebase":
      return t("将当前 Branch Rebase 到这里…");
    case "cherryPick":
      return "Cherry-pick";
    case "revert":
      return "Revert";
    case "reset":
      return t("Reset 当前 Branch 到这里…");
    case "checkoutCommit":
      return t("Checkout 此 Commit…");
    case "fetch":
      return "Fetch";
    case "pull":
      return "Pull";
    case "push":
      return "Push";
    case "stash":
      return t("保存到 Stash…");
    case "stashApply":
      return t("Apply Stash…");
    case "stashPop":
      return t("Pop Stash…");
    case "stashDrop":
      return t("删除 Stash…");
    case "continue":
      return t("继续操作");
    case "abort":
      return t("中止操作…");
    case "stageResolution":
      return t("Stage 冲突解决结果");
  }
}
export function actionExplanation(kind: HistoryActionKind, mode?: string) {
  switch (kind) {
    case "switch":
      return t("切换到所选 Branch。远程 Branch 会创建本地 tracking Branch。");
    case "createBranch":
      return t("在所选 Commit 创建 Branch，当前 Branch 保持不变。");
    case "renameBranch":
      return t("重命名本地 Branch，同时保留它的 tracking 配置。");
    case "deleteBranch":
      return t(
        "删除本地 Branch。Git 会拒绝删除未合并或在其他 Worktree 中使用的 Branch。",
      );
    case "createTag":
      return t("在所选 Commit 创建本地 lightweight Tag。");
    case "merge":
      return t(
        "把目标合入当前 Branch；可以 fast-forward 时直接前移，否则创建 Merge Commit。",
      );
    case "rebase":
      return t(
        "将当前 Branch 的独有 Commits 重放到目标上。这会改写这些 Commits 的 ID。",
      );
    case "cherryPick":
      return t("把所选 Commit 的修改应用到当前 Branch，并创建新 Commit。");
    case "revert":
      return t("创建新 Commit 来撤销所选 Commit 的修改。");
    case "reset":
      return mode === "hard"
        ? t(
            "移动当前 Branch，并用目标版本覆盖 Index 和 Worktree。未 Commit 的修改可能永久丢失，包括妨碍写入的 untracked 文件。",
          )
        : mode === "soft"
          ? t("移动当前 Branch，保留 Index 和 Worktree；修改仍在 Stage 中。")
          : t(
              "移动当前 Branch 并重置 Index，保留 Worktree 文件；修改变为 unstaged。",
            );
    case "checkoutCommit":
      return t("以 Detached HEAD 查看此 Commit。可随时 Switch 回原 Branch。");
    case "fetch":
      return t(
        "获取所选 Remote 的 Branch 更新，更新本地 remote-tracking refs。",
      );
    case "pull":
      return mode === "rebase"
        ? t("获取远程 Branch，再将当前 Branch 的本地 Commits Rebase 到它之上。")
        : mode === "merge"
          ? t(
              "获取远程 Branch 并 Merge 到当前 Branch，必要时创建 Merge Commit。",
            )
          : t("获取远程 Branch，仅允许 fast-forward；存在分叉时停止。");
    case "push":
      return mode === "force-with-lease"
        ? t(
            "用本地 Branch 的历史更新远程 Branch。仅当远程仍指向下方确认的 Commit 时执行；远程发生变化则停止。",
          )
        : t(
            "把所选本地 Branch 推送到远程 Branch，并设置 upstream。远程不允许 fast-forward 时停止。",
          );
    case "stash":
      return t(
        "保存本地修改并清理对应的 Worktree 内容，可稍后从 Stash 恢复。忽略的文件会保留。",
      );
    case "stashApply":
      return t("恢复此 Stash 的修改，并保留 Stash。发生冲突时请手动解决。");
    case "stashPop":
      return t("恢复此 Stash 的修改，成功后删除 Stash。发生冲突时保留 Stash。");
    case "stashDrop":
      return t(
        "删除此 Stash，Worktree 保持不变。删除后无法再从 Stash 列表恢复。",
      );
    case "continue":
      return t("使用已 Stage 的冲突解决结果继续当前 Git 操作。");
    case "abort":
      return t(
        "中止当前 Git 操作，尝试恢复操作前的状态。冲突解决期间的修改可能丢失。",
      );
    case "stageResolution":
      return t(
        "请先在编辑器中解决此文件的冲突。此操作会将文件当前内容加入 Index，标记为已解决。",
      );
  }
}
