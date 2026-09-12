import type { CommitGraphPage } from "./types";

const oid = (value: number) =>
  ((value * 0x9e3779b1) >>> 0).toString(16).padStart(8, "0") +
  value.toString(16).padStart(32, "0");
export const DEMO_HEAD = oid(30);
const forks: Record<number, number[]> = {
  30: [29, 25],
  29: [28],
  28: [24],
  27: [26],
  26: [23],
  25: [22],
  24: [23],
  23: [20],
  22: [21],
  21: [20],
  20: [19, 17],
  19: [18],
  18: [16],
  17: [16],
};
const subjects = [
  "Merge branch 'feature/request-validation'",
  "完善错误响应与请求追踪",
  "统一 API 响应格式",
  "补充边界输入的测试覆盖",
  "为超大请求添加读取限制",
  "保留字段级验证错误",
  "提取可复用的请求上下文",
  "支持 request ID 透传",
  "补充校验器类型定义",
  "实现请求数据校验",
  "Merge branch 'docs/api-reference'",
  "简化路由注册接口",
  "移除重复的中间件初始化",
  "更新 API 使用文档",
  "增加分页参数解析",
  "处理空请求体",
  "完善开发环境启动脚本",
  "增加健康检查接口",
  "修复响应头大小写处理",
  "整理请求生命周期",
  "添加结构化日志",
  "配置本地测试环境",
  "实现基础错误类型",
  "调整目录结构",
  "添加 CI 配置",
  "配置 TypeScript",
  "定义 Router 接口",
  "初始化 HTTP 服务",
  "添加项目说明",
  "Initial commit",
];
/** Fictional demo-service data, displayed only behind the app's demo banner. */
export function demoGraphPage(scope = "all"): CommitGraphPage {
  const commits = Array.from({ length: 30 }, (_, index) => {
    const id = 30 - index;
    return {
      oid: oid(id),
      parents: (forks[id] ?? (id === 1 ? [] : [id - 1])).map(oid),
      subject: subjects[index],
      author: ["林舟", "Alex Chen", "许宁"][index % 3],
      date: new Date(Date.UTC(2026, 8, 12, 10, 30 - index * 19)).toISOString(),
      refs:
        id === 30
          ? "HEAD → main, origin/main"
          : id === 27
            ? "feature/input-limits"
            : id === 25
              ? "feature/request-validation"
              : id === 17
                ? "docs/api-reference"
                : id === 10
                  ? "tag: v0.1.0"
                  : "",
    };
  });
  const namedRoots: Record<string, string> = {
    "refs/heads/main": oid(30),
    "refs/remotes/origin/main": oid(30),
    "refs/heads/feature/input-limits": oid(27),
    "refs/heads/feature/request-validation": oid(25),
    "refs/heads/docs/api-reference": oid(17),
  };
  const root =
    scope === "all" || scope === "current"
      ? oid(30)
      : (namedRoots[scope] ?? scope);
  const reachable = new Set<string>();
  const visit = (id: string) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    commits.find((entry) => entry.oid === id)?.parents.forEach(visit);
  };
  if (scope !== "all") visit(root);
  return {
    snapshotId: "demo-graph",
    workspaceId: "demo-worktree",
    scope,
    commits:
      scope === "all"
        ? commits
        : commits.filter((entry) => reachable.has(entry.oid)),
    branches: [
      { name: "main", oid: oid(30), current: true, remote: false },
      {
        name: "feature/input-limits",
        oid: oid(27),
        current: false,
        remote: false,
      },
      {
        name: "feature/request-validation",
        oid: oid(25),
        current: false,
        remote: false,
      },
      {
        name: "docs/api-reference",
        oid: oid(17),
        current: false,
        remote: false,
      },
      { name: "origin/main", oid: oid(30), current: false, remote: true },
    ],
    head: oid(30),
    offset: 0,
    hasMore: false,
    capturedAt: Date.now(),
    shallow: false,
  };
}
