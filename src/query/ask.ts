import type { AskDetailedResult, AskHit, AskOptions, AskResult, OsnovaIndex, OsnovaSymbol } from "../types.js";
import { idf, matchInPath, queryContext, tokenize } from "./context.js";
import type { QueryContext, SearchDocument } from "./context.js";

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
    if (bestLine < symbol.span.startLine) {
      const start = Math.max(1, bestLine);
      return { text: lines.slice(start - 1, Math.min(symbol.span.endLine, start + EXCERPT_LINES - 1)).join("\n"), startLine: start };
    }
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
  const result = askDetailed(index, question, { ...options, limit: options?.limit ?? DEFAULT_LIMIT });
  return { hits: result.hits, filesSearched: result.filesSearched };
}

export function askDetailed(index: OsnovaIndex, question: string, options?: AskOptions): AskDetailedResult {
  const limit = options?.limit ?? Infinity;
  if (options?.limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new RangeError("osnova: ask limit must be a nonnegative safe integer");
  const queryTokens = [...new Set(tokenize(question))];
  const identifiers = new Set((question.match(/[$A-Za-z_][$\w]*/g) ?? []).map((name) => name.toLowerCase()));
  const qualified = new Set((question.match(/[$A-Za-z_][$\w]*(?:\.[$A-Za-z_][$\w]*)+/g) ?? []).map((name) => name.toLowerCase()));
  const filter = options?.in ?? "";
  const filesSearched = [...index.files.keys()].filter((path) => matchInPath([path], filter)).length;
  if ((queryTokens.length === 0 && identifiers.size === 0) || index.files.size === 0) {
    return { scope: "indexed-definitions-and-text", hits: [], filesSearched, totalCandidates: 0, omittedHits: 0, truncated: false };
  }
  const ctx = queryContext(index);
  const full = options?.full ?? false;
  const scored: Array<{ document: SearchDocument; score: number; exact: boolean }> = [];
  for (const document of ctx.documents) {
    if (!matchInPath([document.file], filter)) continue;
    const symbol = document.symbol;
    const localName = symbol?.qualifiedName.split("#").slice(1).join("#").toLowerCase() ?? "";
    const priority = symbol !== null && localName.includes(".") && qualified.has(localName) ? 2
      : symbol !== null && identifiers.has(symbol.name.toLowerCase()) ? 1 : 0;
    let lexical = 0;
    const normalization = 1.2 * (0.25 + 0.75 * document.length / ctx.averageLength);
    for (const term of queryTokens) {
      const tf = document.body.get(term) ?? 0;
      lexical += idf(ctx, term) * (
        (document.name.has(term) ? 8 : 0) + (document.signature.has(term) ? 4 : 0) +
        (document.documentation.has(term) ? 3 : 0) + (document.path.has(term) ? 1 : 0) +
        (tf === 0 ? 0 : 2.2 * tf / (tf + normalization))
      );
    }
    if (priority > 0 || lexical > 0) {
      scored.push({ document, score: priority + lexical / (1 + lexical), exact: priority > 0 });
    }
  }
  const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
  scored.sort((a, b) => b.score - a.score || compare(a.document.file, b.document.file) ||
    (a.document.symbol?.span.startLine ?? 0) - (b.document.symbol?.span.startLine ?? 0) ||
    (a.document.symbol?.span.startCol ?? 0) - (b.document.symbol?.span.startCol ?? 0) ||
    compare(a.document.symbol?.qualifiedName ?? "", b.document.symbol?.qualifiedName ?? ""));
  const candidates: Array<{ document: SearchDocument; score: number; exact: boolean }> = [];
  const seen = new Set<string>();
  for (const { document, score, exact } of scored) {
    const symbol = document.symbol;
    const key = symbol === null ? `file:${document.file}` : `symbol:${symbol.qualifiedName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ document, score, exact });
  }
  const hits: AskHit[] = [];
  for (const { document, score, exact } of candidates.slice(0, limit)) {
    const symbol = document.symbol;
    const lines = ctx.lines.get(document.file) ?? [];
    const bestLine = exact && symbol !== null ? symbol.span.startLine : bestMatchLine(document, ctx, queryTokens);
    const excerpt = excerptFor(lines, bestLine, symbol, full);
    hits.push({
      file: document.file,
      line: bestLine,
      score,
      symbol,
      excerpt: excerpt.text,
      excerptStartLine: excerpt.startLine,
    });
  }
  const omittedHits = candidates.length - hits.length;
  return {
    scope: "indexed-definitions-and-text", hits, filesSearched,
    totalCandidates: candidates.length, omittedHits, truncated: omittedHits > 0,
  };
}

function bestMatchLine(document: SearchDocument, ctx: QueryContext, query: readonly string[]): number {
  const lines = ctx.lines.get(document.file) ?? [];
  const ranges = document.documentationRange === null ? document.ranges : [document.documentationRange, ...document.ranges];
  let best = document.symbol?.span.startLine ?? 1;
  let bestScore = 0;
  for (const range of ranges) {
    for (let line = range.start; line <= range.end; line += 1) {
      const tokens = new Set(tokenize(lines[line - 1] ?? ""));
      const score = query.reduce((sum, term) => sum + (tokens.has(term) ? idf(ctx, term) : 0), 0);
      if (score > bestScore) {
        best = line;
        bestScore = score;
      }
    }
  }
  return best;
}
