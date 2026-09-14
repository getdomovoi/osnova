import type { OsnovaIndex, SkeletonEntry, SkeletonResult } from "../types.js";

export function skeleton(index: OsnovaIndex, file: string): SkeletonResult {
  const card = index.files.get(file);
  if (card === undefined) {
    throw new Error(
      `osnova: file ${JSON.stringify(file)} is not indexed; use findText or ask to locate it`,
    );
  }
  const entries: SkeletonEntry[] = card.symbols.map((symbol) => ({
    symbol,
    signature: symbol.signature,
  }));
  entries.sort(
    (a, b) =>
      a.symbol.span.startLine - b.symbol.span.startLine ||
      a.symbol.span.endLine - b.symbol.span.endLine ||
      (a.symbol.name < b.symbol.name ? -1 : 1),
  );
  return {
    file,
    language: card.language,
    lineCount: card.lineCount,
    entries,
  };
}
