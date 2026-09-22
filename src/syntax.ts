import Prism from "prismjs";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-go";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-python";
import "prismjs/components/prism-json";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-java";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-markdown";
import type { DiffLine } from "./types";

export interface SyntaxSpan {
  start: number;
  end: number;
  style: string;
}
const languages: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "tsx",
  jsx: "jsx",
  go: "go",
  rs: "rust",
  py: "python",
  json: "json",
  sh: "bash",
  zsh: "bash",
  bash: "bash",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  java: "java",
  sql: "sql",
  html: "markup",
  xml: "markup",
  svg: "markup",
  css: "css",
  md: "markdown",
};
const styles: Record<string, string> = {
  keyword: "keyword",
  builtin: "type",
  "class-name": "type",
  function: "function",
  "function-variable": "function",
  number: "number",
  boolean: "constant",
  constant: "constant",
  string: "string",
  char: "string",
  regex: "string",
  comment: "comment",
  prolog: "comment",
  operator: "operator",
  punctuation: "punctuation",
  property: "property",
  "attr-name": "property",
  "attr-value": "string",
  tag: "tag",
  selector: "tag",
  variable: "variable",
  parameter: "variable",
  decorator: "function",
  annotation: "function",
  important: "keyword",
  bold: "type",
  title: "type",
  url: "string",
};
const cache = new Map<string, SyntaxSpan[]>();
let cacheBytes = 0;
export function clearSyntaxCache() {
  cache.clear();
  cacheBytes = 0;
}
/** 状态栏展示用的语言名（Prism 语言 id → 显示名）。 */
const languageNames: Record<string, string> = {
  typescript: "TypeScript",
  tsx: "TSX",
  javascript: "JavaScript",
  jsx: "JSX",
  go: "Go",
  rust: "Rust",
  python: "Python",
  json: "JSON",
  bash: "Shell",
  yaml: "YAML",
  toml: "TOML",
  c: "C",
  cpp: "C++",
  java: "Java",
  sql: "SQL",
  markup: "HTML",
  css: "CSS",
  markdown: "Markdown",
};
export function languageLabel(path?: string): string {
  const name = path?.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const label = languageNames[languages[ext] ?? ""];
  if (label) return label;
  return ext ? ext.toUpperCase() : "";
}
export function syntaxRanges(text: string, path?: string): SyntaxSpan[] {
  if (!text || text.length > 50_000) return [];
  const language = path
    ? languages[path.split(".").pop()!.toLowerCase()]
    : text.trimStart().startsWith("#")
      ? "python"
      : "javascript";
  const grammar = language && Prism.languages[language];
  if (!grammar) return [];
  const key = `${language}:${text}`,
    existing = cache.get(key);
  if (existing) return existing;
  const spans: SyntaxSpan[] = [];
  let position = 0;
  function walk(
    value: string | Prism.Token | (string | Prism.Token)[],
    inherited = "",
  ) {
    if (typeof value === "string") {
      if (inherited && value.length)
        spans.push({
          start: position,
          end: position + value.length,
          style: `syntax-${inherited}`,
        });
      position += value.length;
    } else if (Array.isArray(value))
      value.forEach((item) => walk(item, inherited));
    else walk(value.content, styles[value.type] ?? inherited);
  }
  try {
    walk(Prism.tokenize(text, grammar));
  } catch {
    return [];
  }
  // Cache actual text, not DOM/HTML. Bound both entry count and retained bytes.
  const bytes = key.length * 2 + spans.length * 48;
  if (bytes > 1_000_000) return [];
  while (cache.size && (cacheBytes + bytes > 2_000_000 || cache.size >= 256)) {
    const [oldKey, old] = cache.entries().next().value!;
    cacheBytes -= oldKey.length * 2 + old.length * 48;
    cache.delete(oldKey);
  }
  cache.set(key, spans);
  cacheBytes += bytes;
  return spans;
}

/** Parse each contiguous hunk side so multiline comments/strings keep context.
 * Large files fall back to bounded per-visible-line highlighting. */
export function hunkSyntax(hunks: { lines: DiffLine[] }[], path: string) {
  const result = {
    old: new WeakMap<DiffLine, SyntaxSpan[]>(),
    new: new WeakMap<DiffLine, SyntaxSpan[]>(),
  };
  let budget = 100_000;
  for (const hunk of hunks)
    for (const side of ["old", "new"] as const) {
      const lines = hunk.lines.filter(
        (line) =>
          line.kind !== (side === "old" ? "add" : "delete") &&
          line.kind !== "note",
      );
      const length = lines.reduce(
        (size, line) => size + line.content.length + 1,
        0,
      );
      if (length > budget || length > 50_000) continue;
      budget -= length;
      const spans = syntaxRanges(
        lines.map((line) => line.content).join("\n"),
        path,
      );
      let position = 0,
        index = 0;
      for (const line of lines) {
        const end = position + line.content.length,
          tokens: SyntaxSpan[] = [];
        while (index < spans.length && spans[index].end <= position) index++;
        for (let at = index; at < spans.length && spans[at].start < end; at++)
          tokens.push({
            start: Math.max(0, spans[at].start - position),
            end: Math.min(line.content.length, spans[at].end - position),
            style: spans[at].style,
          });
        result[side].set(line, tokens);
        position = end + 1;
      }
    }
  return result;
}
