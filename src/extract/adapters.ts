import { EMPTY_ADAPTER_OUTPUT } from "./adapter.js";
import type { LanguageAdapter } from "./adapter.js";
import { makeTsLikeAdapter } from "./typescript.js";
import { pythonAdapter } from "./python.js";
import { goAdapter } from "./go.js";
import { rustAdapter } from "./rust.js";
import { javaAdapter } from "./java.js";
import { csharpAdapter } from "./csharp.js";
import type { LanguageId } from "../types.js";

const adapters: Readonly<Record<LanguageId, LanguageAdapter>> = {
  typescript: makeTsLikeAdapter("typescript"),
  tsx: makeTsLikeAdapter("tsx"),
  javascript: makeTsLikeAdapter("javascript"),
  python: pythonAdapter,
  go: goAdapter,
  rust: rustAdapter,
  java: javaAdapter,
  c_sharp: csharpAdapter,
};

export function adapterFor(language: LanguageId): LanguageAdapter {
  return adapters[language];
}

export const fallbackAdapter: LanguageAdapter = {
  language: "fallback",
  extract: () => EMPTY_ADAPTER_OUTPUT,
};
