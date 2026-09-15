import { EMPTY_ADAPTER_OUTPUT } from "./adapter.js";
import type { LanguageAdapter } from "./adapter.js";
import { makeTsLikeAdapter } from "./typescript.js";
import { pythonAdapter } from "./python.js";
import { goAdapter } from "./go.js";
import { rustAdapter } from "./rust.js";
import { javaAdapter } from "./java.js";
import { csharpAdapter } from "./csharp.js";
import { makeGenericAdapter } from "./generic.js";
import { queryFor } from "../grammar/queries/index.js";
import { genericLanguages } from "../grammar/languages.js";
import { loadedLanguage } from "../grammar/loader.js";
import type { LanguageId } from "../types.js";

const adapters: Partial<Record<LanguageId, LanguageAdapter>> = {
  typescript: makeTsLikeAdapter("typescript"),
  tsx: makeTsLikeAdapter("tsx"),
  javascript: makeTsLikeAdapter("javascript"),
  python: pythonAdapter,
  go: goAdapter,
  rust: rustAdapter,
  java: javaAdapter,
  c_sharp: csharpAdapter,
};

const genericIgnoreCallNames: Partial<Record<LanguageId, ReadonlySet<string>>> = {
  elixir: new Set(["def", "defp", "defmodule", "defmacro", "import", "alias", "require", "use"]),
};

for (const language of genericLanguages) {
  const query = queryFor(language);
  if (query === undefined) continue;
  adapters[language] = makeGenericAdapter(
    language,
    query,
    (source) => loadedLanguage(language).query(source),
    genericIgnoreCallNames[language] ?? new Set(),
  );
}

export function adapterFor(language: LanguageId): LanguageAdapter {
  const adapter = adapters[language];
  if (adapter === undefined) throw new Error(`osnova: no adapter for ${language}`);
  return adapter;
}

export const fallbackAdapter: LanguageAdapter = {
  language: "fallback",
  extract: () => EMPTY_ADAPTER_OUTPUT,
};
