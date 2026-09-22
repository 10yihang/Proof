/**
 * 文件类型 → 树图标与颜色类名（「文件」页左栏/标题栏用）。
 * 颜色类名定义在 styles/editor.css（.fi-*）。
 */
import {
  FileC,
  FileCode,
  FileCpp,
  FileCSharp,
  FileCss,
  FileHtml,
  FileImage,
  FileIni,
  FileJs,
  FileJsx,
  FileLock,
  FileMd,
  FilePy,
  FileRs,
  FileSql,
  FileText,
  FileTs,
  FileTsx,
  FileVue,
  FileZip,
  type Icon,
} from "@phosphor-icons/react";

export interface FileKind {
  Icon: Icon;
  /** editor.css 中的配色类名。 */
  className: string;
}

const byExtension: Record<string, FileKind> = {
  ts: { Icon: FileTs, className: "fi-ts" },
  tsx: { Icon: FileTsx, className: "fi-ts" },
  mts: { Icon: FileTs, className: "fi-ts" },
  cts: { Icon: FileTs, className: "fi-ts" },
  js: { Icon: FileJs, className: "fi-js" },
  mjs: { Icon: FileJs, className: "fi-js" },
  cjs: { Icon: FileJs, className: "fi-js" },
  jsx: { Icon: FileJsx, className: "fi-js" },
  vue: { Icon: FileVue, className: "fi-vue" },
  rs: { Icon: FileRs, className: "fi-rs" },
  py: { Icon: FilePy, className: "fi-py" },
  go: { Icon: FileCode, className: "fi-go" },
  java: { Icon: FileCode, className: "fi-java" },
  kt: { Icon: FileCode, className: "fi-java" },
  kts: { Icon: FileCode, className: "fi-java" },
  c: { Icon: FileC, className: "fi-c" },
  h: { Icon: FileC, className: "fi-c" },
  cpp: { Icon: FileCpp, className: "fi-c" },
  cc: { Icon: FileCpp, className: "fi-c" },
  hpp: { Icon: FileCpp, className: "fi-c" },
  cs: { Icon: FileCSharp, className: "fi-c" },
  html: { Icon: FileHtml, className: "fi-html" },
  htm: { Icon: FileHtml, className: "fi-html" },
  css: { Icon: FileCss, className: "fi-css" },
  scss: { Icon: FileCss, className: "fi-css" },
  less: { Icon: FileCss, className: "fi-css" },
  md: { Icon: FileMd, className: "fi-md" },
  markdown: { Icon: FileMd, className: "fi-md" },
  json: { Icon: FileCode, className: "fi-json" },
  jsonc: { Icon: FileCode, className: "fi-json" },
  yaml: { Icon: FileCode, className: "fi-yaml" },
  yml: { Icon: FileCode, className: "fi-yaml" },
  toml: { Icon: FileIni, className: "fi-yaml" },
  ini: { Icon: FileIni, className: "fi-yaml" },
  sql: { Icon: FileSql, className: "fi-sql" },
  sh: { Icon: FileCode, className: "fi-sh" },
  bash: { Icon: FileCode, className: "fi-sh" },
  zsh: { Icon: FileCode, className: "fi-sh" },
  png: { Icon: FileImage, className: "fi-image" },
  jpg: { Icon: FileImage, className: "fi-image" },
  jpeg: { Icon: FileImage, className: "fi-image" },
  gif: { Icon: FileImage, className: "fi-image" },
  webp: { Icon: FileImage, className: "fi-image" },
  svg: { Icon: FileImage, className: "fi-image" },
  ico: { Icon: FileImage, className: "fi-image" },
  zip: { Icon: FileZip, className: "fi-zip" },
  gz: { Icon: FileZip, className: "fi-zip" },
  tar: { Icon: FileZip, className: "fi-zip" },
  lock: { Icon: FileLock, className: "fi-lock" },
};

const fallback: FileKind = { Icon: FileText, className: "fi-text" };

export function fileKind(path: string): FileKind {
  const name = path.split("/").pop() ?? path;
  // 隐藏文件（.gitignore）整体当作扩展名处理不到，取最后一个点后的部分。
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return byExtension[ext] ?? fallback;
}
