import { describe, expect, it } from "vitest";
import {
  activityTasks,
  displayCommand,
  outputExcerpt,
} from "./context-activity";
import type { ContextEvent } from "./components/context-types";

const event = (
  id: string,
  partial: Partial<ContextEvent> = {},
): ContextEvent => ({
  id,
  sessionId: "session",
  nativeSessionId: "native",
  kind: "PostToolUse",
  toolName: "Bash",
  toolRef: id,
  turnId: "turn",
  receivedAt: 100,
  paths: ["src/file.ts"],
  prompt: null,
  command: "cat src/file.ts",
  output: null,
  reply: null,
  exitCode: 0,
  commandState: "command_succeeded",
  fieldStatus: {},
  truncated: false,
  possiblyDuplicate: false,
  ...partial,
});
describe("file activity summaries", () => {
  it("collapses hundreds of repeated observations and keeps failed runs separate", () => {
    const input = Array.from({ length: 300 }, (_, i) => event(String(i)));
    input.push(
      event("failed", { exitCode: 1, commandState: "command_failed" }),
    );
    const [task] = activityTasks(input);
    expect(task.items).toHaveLength(2);
    expect(task.items.find((item) => !item.failed)?.records).toHaveLength(300);
    expect(task.items.find((item) => item.failed)?.records).toHaveLength(1);
    expect(activityTasks([...input, ...input])[0].records).toBe(301);
  });
  it("joins task text only by native Turn ID and keeps independent tasks separate", () => {
    const tasks = activityTasks(
      [event("one"), event("two", { turnId: "another" })],
      [
        event("prompt", { kind: "UserPromptSubmit", prompt: "Fix validation" }),
        event("unrelated", {
          turnId: "unrelated",
          prompt: "Unrelated secrets",
        }),
        event("no-turn", { turnId: null, prompt: "Do not infer proximity" }),
      ],
    );
    expect(tasks).toHaveLength(2);
    expect(tasks.find((task) => task.turnId === "turn")?.prompt?.prompt).toBe(
      "Fix validation",
    );
    expect(
      tasks.find((task) => task.turnId === "another")?.prompt,
    ).toBeUndefined();
  });
  it("shows literal Code Mode commands and useful output without executing or inventing details", () => {
    expect(
      displayCommand(
        'text(await tools.exec_command({cmd: "cargo test\\n", max_output_tokens: 500}))',
      ),
    ).toBe("cargo test\n");
    expect(displayCommand(null)).toBe("");
    const echoed = `echo 'cmd: "not-a-command"'`;
    expect(displayCommand(echoed)).toBe(echoed);
    const computed =
      'await tools.exec_command({cmd: buildCommand(), metadata: {cmd: "unrelated"}})';
    expect(displayCommand(computed)).toBe(computed);
    const escaped = String.raw`await tools.exec_command({cmd: 'echo a\\nb'})`;
    expect(displayCommand(escaped)).toBe(escaped);

    expect(
      outputExcerpt(
        "Chunk ID: abc\nWall time: 0.1\nProcess exited with code 1\nFinal output:\nerror: failed assertion",
      ),
    ).toBe("error: failed assertion");
    const item = activityTasks([
      event("empty", {
        command: null,
        exitCode: null,
        fieldStatus: { command: "not_authorized" },
      }),
    ])[0].items[0];
    expect(item.command).toBe("");
    expect(item.failed).toBe(false);
  });
});
