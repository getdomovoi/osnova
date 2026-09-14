import type { LanguageId } from "../types.js";

export const extensionLanguage: Readonly<Record<string, LanguageId>> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".cs": "c_sharp",
};

export const grammarFile: Readonly<Record<LanguageId, string>> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  go: "tree-sitter-go.wasm",
  rust: "tree-sitter-rust.wasm",
  java: "tree-sitter-java.wasm",
  c_sharp: "tree-sitter-c_sharp.wasm",
};

export function languageForPath(path: string): LanguageId | undefined {
  const base = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = base.slice(dot).toLowerCase();
  if (ext === ".d.ts" || base.endsWith(".d.ts")) return undefined;
  return extensionLanguage[ext];
}
