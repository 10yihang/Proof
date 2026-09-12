import type { ChangedFile, Changes, FileDiff, Hunk } from "./types";

// All names and code in this fixture are fictional. It is only entered through
// an explicit demo action or ?demo=1; production IPC never falls back to it.
export const demoChanges: Changes = {
  workspace: {
    id: "demo",
    repositoryId: "demo",
    name: "demo-service",
    path: "/演示工作区/demo-service",
    gitDir: "",
    commonDir: "",
    trusted: false,
  },
  head: "9be182c53cf9c79ac5097357692256474f44b2c6",
  branch: "feat/request-validation",
  operation: null,
  token: "demo-snapshot",
  capturedAt: Date.now(),
  gitVersion: "演示数据",
  files: [
    {
      path: "src/api/requests.ts",
      oldPath: null,
      status: "M",
      side: "unstaged",
      conflicted: false,
    },
    {
      path: "src/api/response.ts",
      oldPath: null,
      status: "M",
      side: "unstaged",
      conflicted: false,
    },
    {
      path: "src/lib/validation.ts",
      oldPath: null,
      status: "?",
      side: "unstaged",
      conflicted: false,
    },
    {
      path: "tests/requests.test.ts",
      oldPath: null,
      status: "M",
      side: "unstaged",
      conflicted: false,
    },
    {
      path: "README.md",
      oldPath: null,
      status: "M",
      side: "staged",
      conflicted: false,
    },
  ],
};
function makeHunk(
  id: string,
  start: number,
  header: string,
  rows: [string, string][],
): Hunk {
  let old = start,
    next = start;
  return {
    id,
    header,
    oldStart: start,
    newStart: start,
    reviewState: "unreviewed",
    lines: rows.map(([kind, content]) => ({
      kind: kind as "add" | "delete" | "context",
      content,
      oldLine: kind === "add" ? null : old++,
      newLine: kind === "delete" ? null : next++,
    })),
  };
}
export function demoDiff(file: ChangedFile): FileDiff {
  const hunks =
    file.path === "src/api/requests.ts"
      ? [
          makeHunk("demo-hunk-1", 1, "@@ -1,9 +1,12 @@", [
            ["context", "import { Router } from './router';"],
            ["context", "import { createResponse } from './response';"],
            [
              "add",
              "import { validateRequest, ValidationError } from '../lib/validation';",
            ],
            ["context", ""],
            [
              "context",
              "export async function handleRequest(request: Request) {",
            ],
            ["delete", "  const body = await request.json();"],
            ["add", "  const payload = await request.json();"],
            ["add", "  const body = validateRequest(payload);"],
            ["context", ""],
            ["context", "  const result = await Router.dispatch(body);"],
            ["context", "  return createResponse(result);"],
            ["context", "}"],
          ]),
          makeHunk(
            "demo-hunk-2",
            24,
            "@@ -24,6 +27,12 @@ export function onError",
            [
              [
                "context",
                "export function onError(error: unknown): Response {",
              ],
              ["add", "  if (error instanceof ValidationError) {"],
              ["add", "    return createResponse({"],
              ["add", "      code: 'INVALID_REQUEST',"],
              ["add", "      message: error.message,"],
              ["add", "    }, { status: 400 });"],
              ["add", "  }"],
              ["context", ""],
              ["context", "  logger.error(error);"],
              [
                "context",
                "  return createResponse({ code: 'INTERNAL_ERROR' }, { status: 500 });",
              ],
              ["context", "}"],
            ],
          ),
        ]
      : [
          makeHunk(`demo-${file.path}`, 1, "@@ -1,3 +1,4 @@", [
            [
              "context",
              file.path.endsWith(".md")
                ? "# Demo service"
                : "// Demo service — interface preview",
            ],
            ["delete", "// Accept the request body"],
            ["add", "// Validate the request before processing"],
            ["add", "// Keep the error response explicit"],
            ["context", ""],
          ]),
        ];
  return {
    id: `demo:${file.path}`,
    workspaceId: "demo",
    path: file.path,
    oldPath: null,
    side: file.side,
    base: "9be182c:feat/request-validation",
    capturedAt: Date.now(),
    token: `demo:${file.path}`,
    patch: hunks
      .map(
        (h) =>
          h.header +
          "\n" +
          h.lines
            .map(
              (l) =>
                `${l.kind === "add" ? "+" : l.kind === "delete" ? "-" : " "}${l.content}`,
            )
            .join("\n"),
      )
      .join("\n"),
    hunks,
    additions: hunks.flatMap((h) => h.lines).filter((l) => l.kind === "add")
      .length,
    deletions: hunks.flatMap((h) => h.lines).filter((l) => l.kind === "delete")
      .length,
    kind: "text",
    notice: null,
    canStage: false,
    canStageHunks: false,
    canDiscard: false,
    canDiscardHunks: false,
    discardReason: "演示数据不可执行丢弃",
  };
}
