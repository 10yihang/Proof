import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(
  /^host: (.+)$/m,
)?.[1];
if (!host) throw new Error("Cannot determine Rust target");
const target =
  process.env.CARGO_BUILD_TARGET ?? process.env.TAURI_ENV_TARGET_TRIPLE ?? host;
const release = !process.argv.includes("--dev");
const args = [
  "build",
  "-p",
  "proof-observer",
  "--bin",
  "proof-observer",
  "--locked",
  "--offline",
];
if (release) args.push("--release");
if (target !== host) args.push("--target", target);
execFileSync("cargo", args, { cwd: root, stdio: "inherit" });
const extension = target.includes("windows") ? ".exe" : "";
const output = path.resolve(
  root,
  process.env.CARGO_TARGET_DIR ?? "target",
  ...(target === host ? [] : [target]),
  release ? "release" : "debug",
  `proof-observer${extension}`,
);
const directory = path.join(root, "src-tauri/binaries");
mkdirSync(directory, { recursive: true });
copyFileSync(
  output,
  path.join(directory, `proof-observer-${target}${extension}`),
);
