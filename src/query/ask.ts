import type { AskHit, AskOptions, AskResult, OsnovaIndex, OsnovaSymbol } from "../types.js";
import { idf, innermostSymbolAt, matchInPath, queryContext, tokenize } from "./context.js";

const DEFAULT_LIMIT = 8;
const EXCERPT_LINES = 8;
const FULL_EXCERPT_MAX_LINES = 400;

function excerptFor(
  lines: readonly string[],
  bestLine: number,
  symbol: OsnovaSymbol | null,
  full: boolean,
): { text: string; startLine: number } {
  if (full) {
    if (symbol !== null) {
      const start = symbol.span.startLine;
      const end = Math.min(symbol.span.endLine, start + FULL_EXCERPT_MAX_LINES - 1);
      return { text: lines.slice(start - 1, end).join("\n"), startLine: start };
    }
    const start = Math.max(1, bestLine - 3);
    const end = Math.min(lines.length, start + FULL_EXCERPT_MAX_LINES - 1);
    return { text: lines.slice(start - 1, end).join("\n"), startLine: start };
  }
  if (symbol !== null) {
    const start = Math.max(
      symbol.span.startLine,
      Math.min(bestLine - 2, symbol.span.endLine - EXCERPT_LINES + 1),
    );
    const end = Math.min(symbol.span.endLine, start + EXCERPT_LINES - 1);
    return { text: lines.slice(start - 1, end).join("\n"), startLine: Math.max(start, symbol.span.startLine) };
  }
  const start = Math.max(1, bestLine - 3);
  const end = Math.min(lines.length, start + EXCERPT_LINES - 1);
  return { text: lines.slice(start - 1, end).join("\n"), startLine: start };
}

export function ask(index: OsnovaIndex, question: string, options?: AskOptions): AskResult {
  const ctx = queryContext(index);
  const queryTokens = [...new Set(tokenize(question))];
  if (queryTokens.length === 0 || ctx.fileCount === 0) {
    return { hits: [], filesSearched: 0 };
  }
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const full = options?.full ?? false;
  const filter = options?.in ?? "";
  const questionLower = question.toLowerCase();

  const paths = [...index.files.keys()].sort();
  const scored: Array<{ path: string; score: number }> = [];
  for (const path of paths) {
    if (!matchInPath([path], filter)) continue;
    const counts = ctx.termCounts.get(path);
    if (counts === undefined) continue;
    let score = 0;
    for (const term of queryTokens) {
      const tf = counts.get(term);
      if (tf === undefined) continue;
      score += (tf / (ctx.docLen.get(path) ?? 1)) * idf(ctx, term);
    }
    const card = index.files.get(path);
    if (card !== undefined) {
      for (const symbol of card.symbols) {
        const nameLower = symbol.name.toLowerCase();
        if (nameLower.length >= 2 && questionLower.includes(nameLower)) {
          score += 4 * idf(ctx, nameLower) + 1;
        }
        for (const token of ctx.symbolTokens.get(symbol.qualifiedName) ?? []) {
          if (queryTokens.includes(token)) {
            score += idf(ctx, token);
          }
        }
      }
    }
    if (score > 0) scored.push({ path, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));

  const hits: AskHit[] = [];
  for (const { path, score } of scored.slice(0, limit)) {
    const card = index.files.get(path);
    if (card === undefined) continue;
    const lines = card.text.length === 0 ? [] : card.text.split("\n");
    let bestLine = 1;
    for (let i = 0; i < lines.length; i += 1) {
      const lineLower = (lines[i] ?? "").toLowerCase();
      if (queryTokens.some((t) => lineLower.includes(t))) {
        bestLine = i + 1;
        break;
      }
    }
    const symbolQ = innermostSymbolAt(index, path, bestLine);
    const symbol = symbolQ !== null ? (index.symbols.get(symbolQ) ?? null) : null;
    const excerpt = excerptFor(lines, bestLine, symbol, full);
    hits.push({
      file: path,
      line: bestLine,
      score,
      symbol,
      excerpt: excerpt.text,
      excerptStartLine: excerpt.startLine,
    });
  }
  return { hits, filesSearched: scored.length };
}
