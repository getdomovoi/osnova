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
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".hxx": "cpp",
  ".m": "objc",
  ".mm": "objc",
  ".rb": "ruby",
  ".php": "php",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".scala": "scala",
  ".sc": "scala",
  ".dart": "dart",
  ".ex": "elixir",
  ".exs": "elixir",
  ".ml": "ocaml",
  ".mli": "ocaml",
  ".zig": "zig",
  ".sh": "bash",
  ".bash": "bash",
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
  c: "tree-sitter-c.wasm",
  cpp: "tree-sitter-cpp.wasm",
  objc: "tree-sitter-objc.wasm",
  ruby: "tree-sitter-ruby.wasm",
  php: "tree-sitter-php.wasm",
  kotlin: "tree-sitter-kotlin.wasm",
  swift: "tree-sitter-swift.wasm",
  scala: "tree-sitter-scala.wasm",
  dart: "tree-sitter-dart.wasm",
  elixir: "tree-sitter-elixir.wasm",
  ocaml: "tree-sitter-ocaml.wasm",
  zig: "tree-sitter-zig.wasm",
  bash: "tree-sitter-bash.wasm",
};

export function languageForPath(path: string): LanguageId | undefined {
  const base = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = base.slice(dot).toLowerCase();
  if (ext === ".d.ts" || base.endsWith(".d.ts")) return undefined;
  return extensionLanguage[ext];
}

export type LanguageTier = "adapter" | "generic";

export const languageTier: Readonly<Record<LanguageId, LanguageTier>> = {
  typescript: "adapter",
  tsx: "adapter",
  javascript: "adapter",
  python: "adapter",
  go: "adapter",
  rust: "adapter",
  java: "adapter",
  c_sharp: "adapter",
  c: "generic",
  cpp: "generic",
  objc: "generic",
  ruby: "generic",
  php: "generic",
  kotlin: "generic",
  swift: "generic",
  scala: "generic",
  dart: "generic",
  elixir: "generic",
  ocaml: "generic",
  zig: "generic",
  bash: "generic",
};

export const genericLanguages: readonly LanguageId[] = (Object.keys(languageTier) as LanguageId[]).filter(
  (language) => languageTier[language] === "generic",
);
