import type { FindTextGroup, FindTextMatch, FindTextOptions, OsnovaIndex } from "../types.js";
import { matchInPath } from "./context.js";

const DEFAULT_GROUP_LIMIT = 50;
const MATCHES_PER_GROUP = 10;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findText(
  index: OsnovaIndex,
  pattern: string,
  options?: FindTextOptions,
): FindTextGroup[] {
  const source = options?.fixed === true ? escapeRegExp(pattern) : pattern;
  let regex: RegExp;
  try {
    regex = new RegExp(source, options?.ignoreCase === true ? "gi" : "g");
  } catch (error) {
    throw new Error(`osnova: invalid pattern ${JSON.stringify(pattern)}: ${String(error)}`, {
      cause: error,
    });
  }
  const filter = options?.in ?? "";
  const groupLimit = options?.limit ?? DEFAULT_GROUP_LIMIT;

  interface Group {
    file: string;
    symbolQ: string | null;
    matches: FindTextMatch[];
  }
  const groups: Group[] = [];
  const byKey = new Map<string, Group>();

  for (const path of [...index.files.keys()].sort()) {
    if (!matchInPath([path], filter)) continue;
    const card = index.files.get(path);
    if (card === undefined || card.text.length === 0) continue;
    const lines = card.text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      regex.lastIndex = 0;
      let match: RegExpExecArray | null = regex.exec(line);
      while (match !== null) {
        const symbolQ = innermostForLine(card.symbols, i + 1);
        const key = `${path}\u0000${symbolQ ?? "<module>"}`;
        let group = byKey.get(key);
        if (group === undefined) {
          group = { file: path, symbolQ, matches: [] };
          byKey.set(key, group);
          groups.push(group);
        }
        if (group.matches.length < MATCHES_PER_GROUP) {
          const hit: FindTextMatch = { line: i + 1, col: match.index, text: line };
          const last = group.matches[group.matches.length - 1];
          if (last === undefined || last.line !== hit.line || last.col !== hit.col) {
            group.matches.push(hit);
          }
        }
        if (match[0].length === 0) regex.lastIndex += 1;
        match = regex.exec(line);
      }
    }
  }

  const ranked = groups.map((group) => {
    const incoming =
      group.symbolQ !== null
        ? index.incoming(group.symbolQ).length
        : 0;
    const symbol = group.symbolQ !== null ? (index.symbols.get(group.symbolQ) ?? null) : null;
    return { group, incoming, symbol };
  });
  ranked.sort(
    (a, b) =>
      b.incoming - a.incoming ||
      (a.group.file < b.group.file ? -1 : a.group.file > b.group.file ? 1 : 0) ||
      (a.group.symbolQ ?? "").localeCompare(b.group.symbolQ ?? ""),
  );
  return ranked.slice(0, groupLimit).map(({ group, incoming, symbol }) => ({
    file: group.file,
    symbol,
    incomingEdges: incoming,
    matches: group.matches,
  }));
}

function innermostForLine(
  symbols: readonly { qualifiedName: string; span: { startLine: number; endLine: number } }[],
  line: number,
): string | null {
  let best: { q: string; size: number } | null = null;
  for (const symbol of symbols) {
    if (line < symbol.span.startLine || line > symbol.span.endLine) continue;
    const size = symbol.span.endLine - symbol.span.startLine;
    if (best === null || size < best.size) best = { q: symbol.qualifiedName, size };
  }
  return best !== null ? best.q : null;
}
