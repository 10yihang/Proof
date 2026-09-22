import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  clearScreen: false,
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
  // dev 下把巨型依赖预打包成少量 chunk：monaco ESM 有数千个模块、phosphor
  // 桶文件导出全部图标，不预打包会让 dev server 的模块图把 Node 堆吃爆。
  optimizeDeps: {
    include: [
      "monaco-editor/editor/editor.api",
      "monaco-editor/editor/contrib/clipboard/browser/clipboard",
      "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching",
      "monaco-editor/editor/contrib/find/browser/findController",
      "monaco-editor/editor/contrib/folding/browser/folding",
      "@phosphor-icons/react",
      "@xterm/xterm",
      "@xterm/addon-fit",
    ],
  },
  build: { target: "es2022" },
  test: { include: ["src/**/*.test.ts"] },
});
