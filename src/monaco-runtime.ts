import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/editor/contrib/clipboard/browser/clipboard";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching";
import "monaco-editor/editor/contrib/find/browser/findController";
import "monaco-editor/editor/contrib/folding/browser/folding";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import { syntaxRanges } from "./syntax";
import type { GitEditorDocument } from "./monaco-document";

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

const palette = {
  light: {
    background: "#ffffff",
    foreground: "#263144",
    gutter: "#6b7789",
    selection: "#dbe9ff",
    keyword: "#8952bb",
    type: "#267285",
    function: "#3266a6",
    string: "#267654",
    number: "#a86928",
    comment: "#75818b",
    operator: "#637089",
    property: "#a04472",
    punctuation: "#6a7484",
  },
  dark: {
    background: "#17191d",
    foreground: "#dce5f2",
    gutter: "#8592a5",
    selection: "#30486b",
    keyword: "#cda6f4",
    type: "#7ec6ca",
    function: "#9bbffd",
    string: "#a3d4aa",
    number: "#e8bd83",
    comment: "#8e9dae",
    operator: "#adbacd",
    property: "#e4a2c7",
    punctuation: "#adbacd",
  },
};
const registered: string[] = [];
const used = new Set<string>();
for (const mode of ["light", "dark"] as const) {
  const colors = palette[mode];
  monaco.editor.defineTheme(`proof-${mode}`, {
    base: mode === "dark" ? "vs-dark" : "vs",
    inherit: true,
    rules: Object.entries({
      ...colors,
      constant: colors.number,
      tag: colors.keyword,
      variable: colors.property,
    }).map(([token, value]) => ({
      token: `proof.${token}`,
      foreground: value.slice(1),
    })),
    colors: {
      "editor.background": colors.background,
      "editor.foreground": colors.foreground,
      "editorLineNumber.foreground": colors.gutter,
      "editorLineNumber.activeForeground": colors.foreground,
      "editor.selectionBackground": colors.selection,
      "editor.inactiveSelectionBackground": `${colors.selection}a0`,
      "editorGutter.background": colors.background,
      "editorCursor.foreground": colors.foreground,
      "editor.lineHighlightBackground": "#00000000",
      "editorWhitespace.foreground": mode === "dark" ? "#596679" : "#b4bdcb",
      "editorOverviewRuler.border": "#00000000",
      "scrollbar.shadow": "#00000000",
      focusBorder: "#00000000",
    },
  });
}
class GitTokenState implements monaco.languages.IState {
  constructor(readonly line: number) {}
  clone() {
    return new GitTokenState(this.line);
  }
  equals(other: monaco.languages.IState) {
    return other instanceof GitTokenState && other.line === this.line;
  }
}
/** Preserve the two Git histories when coloring a unified view. */
export function registerGitTokens(document: GitEditorDocument, path: string) {
  let id = registered.find((value) => !used.has(value));
  if (!id) {
    id = `proof-git-${registered.length}`;
    registered.push(id);
    monaco.languages.register({ id });
  }
  used.add(id);
  const provider = monaco.languages.setTokensProvider(id, {
    getInitialState: () => new GitTokenState(0),
    tokenize(line, state) {
      const index = (state as GitTokenState).line,
        entry = document.lines[index];
      const tokens: monaco.languages.IToken[] = [
        { startIndex: 0, scopes: "proof.foreground" },
      ];
      if (entry?.source.content.replace(/\r$/, "") === line)
        for (const span of entry.tokens ?? syntaxRanges(line, path)) {
          if (span.start >= line.length) break;
          if (tokens[tokens.length - 1].startIndex === span.start) tokens.pop();
          tokens.push({
            startIndex: span.start,
            scopes: `proof.${span.style.replace(/^syntax-/, "")}`,
          });
          if (span.end < line.length)
            tokens.push({ startIndex: span.end, scopes: "proof.foreground" });
        }
      return { tokens, endState: new GitTokenState(index + 1) };
    },
  });
  return {
    id,
    dispose() {
      provider.dispose();
      used.delete(id);
    },
  };
}
/** Color a plain text model (the built-in editor) with the Prism spans. */
export function registerTextTokens(path: string) {
  let id = registered.find((value) => !used.has(value));
  if (!id) {
    id = `proof-git-${registered.length}`;
    registered.push(id);
    monaco.languages.register({ id });
  }
  used.add(id);
  const provider = monaco.languages.setTokensProvider(id, {
    getInitialState: () => new GitTokenState(0),
    tokenize(line, state) {
      const index = (state as GitTokenState).line;
      const tokens: monaco.languages.IToken[] = [
        { startIndex: 0, scopes: "proof.foreground" },
      ];
      for (const span of syntaxRanges(line, path)) {
        if (span.start >= line.length) break;
        if (tokens[tokens.length - 1].startIndex === span.start) tokens.pop();
        tokens.push({
          startIndex: span.start,
          scopes: `proof.${span.style.replace(/^syntax-/, "")}`,
        });
        if (span.end < line.length)
          tokens.push({ startIndex: span.end, scopes: "proof.foreground" });
      }
      return { tokens, endState: new GitTokenState(index + 1) };
    },
  });
  return {
    id,
    dispose() {
      provider.dispose();
      used.delete(id);
    },
  };
}
export { monaco };
