import type { ContextEvent } from "./components/context-types";

export type ActivityKind =
  "edit" | "read" | "search" | "check" | "command" | "other";
export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  event: ContextEvent;
  records: ContextEvent[];
  command: string;
  failed: boolean;
}
export interface ActivityTask {
  id: string;
  turnId: string | null;
  prompt: ContextEvent | undefined;
  reply: ContextEvent | undefined;
  items: ActivityItem[];
  records: number;
  receivedAt: number;
}

// Read literal command arguments from a Code Mode wrapper, never evaluate it.
export function displayCommand(value: string | null): string {
  if (!value) return "";
  const match = value.match(
    /^\s*(?:(?:const|let|var)\s+\w+\s*=\s*)?(?:text\(\s*)?await\s+tools\.exec_command\(\s*\{\s*(?:cmd|command|"cmd"|"command")\s*:\s*("(?:\\.|[^"\\])*"|'[^'\\]*')(?=\s*[,}])/s,
  );
  if (match) {
    try {
      return match[1].startsWith('"')
        ? (JSON.parse(match[1]) as string)
        : match[1].slice(1, -1);
    } catch {
      /* Show the original text when literal decoding is uncertain. */
    }
  }
  return value;
}
export function activityKind(event: ContextEvent): ActivityKind {
  const tool = (event.toolName ?? "").toLowerCase();
  const command = displayCommand(event.command);
  if (/^(write|edit|multiedit|apply_patch|patch)$/.test(tool)) return "edit";
  if (
    /^\s*(?:env\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)?(?:cargo\s+(?:test|check|clippy)|(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+(?:test[^\s]*|lint|typecheck|check)|go\s+(?:test|vet)|pytest|vitest|tsc)(?:\s|$)/.test(
      command,
    )
  )
    return "check";
  if (
    /^(read|read_file)$/.test(tool) ||
    /^(cat|head|tail|sed)\s/.test(command.trim())
  )
    return "read";
  if (
    /^(grep|glob|search|list)$/.test(tool) ||
    /^(rg|grep|find|ls)\s/.test(command.trim())
  )
    return "search";
  if (tool === "bash" || command) return "command";
  return "other";
}
export function outputExcerpt(value: string | null): string {
  return (value ?? "")
    .split("\n")
    .filter(
      (line) =>
        line.trim() &&
        !/^(Chunk ID:|Wall time:|Process exited with code|Final output:|Output:)$/.test(
          line.trim(),
        ) &&
        !/^(Chunk ID:|Wall time:|Process exited with code)/.test(line.trim()),
    )
    .slice(0, 3)
    .join("\n")
    .slice(0, 360);
}

export function activityTasks(
  events: ContextEvent[],
  context: ContextEvent[] = [],
): ActivityTask[] {
  const tasks = new Map<string, ActivityTask>();
  const seen = new Set<string>();
  const ordered = [...events].sort(
    (a, b) => b.receivedAt - a.receivedAt || b.id.localeCompare(a.id),
  );
  for (const event of ordered) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    const id = event.turnId
      ? `turn:${event.turnId}`
      : !event.toolName && (event.prompt || event.reply)
        ? `event:${event.id}`
        : "unscoped";
    let task = tasks.get(id);
    if (!task) {
      task = {
        id,
        turnId: event.turnId,
        prompt: undefined,
        reply: undefined,
        items: [],
        records: 0,
        receivedAt: event.receivedAt,
      };
      tasks.set(id, task);
    }
    task.records++;
    if (event.prompt && !task.prompt && (task.turnId || !event.toolName))
      task.prompt = event;
    if (event.reply && !task.reply && (task.turnId || !event.toolName))
      task.reply = event;
    if (
      !event.toolName &&
      /^(UserPromptSubmit|Stop|SubagentStop|SessionStart|SessionEnd)$/.test(
        event.kind,
      )
    )
      continue;
    const kind = activityKind(event);
    const failed =
      event.kind === "PostToolUseFailure" ||
      (event.exitCode !== null && event.exitCode !== 0) ||
      event.commandState.includes("failed");
    const command = displayCommand(event.command);
    // Keep failures separate from success. Identical repeated observations share
    // a row; distinct commands stay available inside their activity category.
    const key = JSON.stringify([
      kind,
      event.toolName,
      command,
      event.paths,
      failed,
      event.exitCode,
      event.fieldStatus?.command,
    ]);
    let item = task.items.find((item) => item.id === key);
    if (!item) {
      item = { id: key, kind, event, command, failed, records: [] };
      task.items.push(item);
    }
    item.records.push(event);
  }
  for (const event of [...context].sort(
    (a, b) => b.receivedAt - a.receivedAt,
  )) {
    if (!event.turnId) continue;
    const task = tasks.get(`turn:${event.turnId}`);
    if (task) {
      if (event.prompt && !task.prompt) task.prompt = event;
      if (event.reply && !task.reply) task.reply = event;
    }
  }
  return [...tasks.values()].filter(
    (task) => task.items.length || task.prompt || task.reply,
  );
}
