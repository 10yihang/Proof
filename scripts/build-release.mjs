import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localKey = path.join(root, ".release-keys/updater.key");
const key = process.env.TAURI_SIGNING_PRIVATE_KEY ?? (existsSync(localKey) ? localKey : undefined);
if (!key) throw new Error("Set TAURI_SIGNING_PRIVATE_KEY to the existing updater key before building a release.");
// CI mode skips Finder AppleScript layout and interactive prompts during packaging.
const env = { ...process.env, CI: "true", TAURI_SIGNING_PRIVATE_KEY: key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "" };
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This release script currently packages macOS Apple Silicon only.");
execFileSync(path.join(root, "node_modules/.bin/tauri"), ["build", "--bundles", "app,dmg"], { cwd: root, env, stdio: "inherit" });
const bundle = path.join(root, "target/release/bundle/macos");
const signature = readFileSync(path.join(bundle, "Proof.app.tar.gz.sig"), "utf8").trim();
const output = path.join(root, ".artifacts/releases", version);
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, "latest.json"), JSON.stringify({
  version,
  notes: readFileSync(path.join(root, "docs/releases", `${version}.md`), "utf8"),
  pub_date: new Date().toISOString(),
  platforms: { "darwin-aarch64": { signature, url: `https://github.com/10yihang/Proof/releases/download/v${version}/Proof.app.tar.gz` } },
}, null, 2) + "\n");
console.log(`Signed updater bundle: ${bundle}/Proof.app.tar.gz\nUpdate manifest: ${output}/latest.json`);
