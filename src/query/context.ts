import type { OsnovaIndex } from "../types.js";

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "of", "in", "to", "for", "and", "or", "how",
  "do", "does", "what", "where", "which", "this", "that", "with", "on", "as",
  "at", "by", "from", "it", "its", "be", "can", "was", "were", "will", "not",
]);

export function tokenize(text: string): string[] {
  const camelSplit = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const raw = camelSplit.toLowerCase().split(/[^a-z0-9_]+/);
  const out: string[] = [];
  for (const token of raw) {
    if (token.length < 2 || token.length > 64) continue;
    if (STOPWORDS.has(token)) continue;
    out.push(token);
  }
  return out;
}

export interface QueryContext {
  readonly index: OsnovaIndex;
  readonly termCounts: Map<string, Map<string, number>>;
  readonly docLen: Map<string, number>;
  readonly df: Map<string, number>;
  readonly fileCount: number;
  readonly symbolTokens: Map<string, string[]>;
}

const contextCache = new WeakMap<OsnovaIndex, QueryContext>();

export function queryContext(index: OsnovaIndex): QueryContext {
  const cached = contextCache.get(index);
  if (cached !== undefined) return cached;
  const termCounts = new Map<string, Map<string, number>>();
  const docLen = new Map<string, number>();
  const df = new Map<string, number>();
  const symbolTokens = new Map<string, string[]>();
  for (const [path, card] of index.files) {
    const counts = new Map<string, number>();
    const tokens = [
      ...tokenize(path),
      ...tokenize(card.text),
    ];
    for (const symbol of card.symbols) {
      tokens.push(...tokenize(symbol.name));
      symbolTokens.set(symbol.qualifiedName, tokenize(symbol.name));
    }
    for (const token of tokens) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    termCounts.set(path, counts);
    docLen.set(path, Math.max(1, Math.sqrt(tokens.length)));
    for (const token of counts.keys()) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }
  const ctx: QueryContext = {
    index,
    termCounts,
    docLen,
    df,
    fileCount: index.files.size,
    symbolTokens,
  };
  contextCache.set(index, ctx);
  return ctx;
}

export function idf(ctx: QueryContext, term: string): number {
  const n = ctx.df.get(term);
  if (n === undefined || ctx.fileCount === 0) return 0;
  return Math.log(1 + ctx.fileCount / n);
}

export function innermostSymbolAt(
  index: OsnovaIndex,
  file: string,
  line: number,
): string | null {
  const card = index.files.get(file);
  if (card === undefined) return null;
  let best: { q: string; size: number } | null = null;
  for (const symbol of card.symbols) {
    if (line < symbol.span.startLine || line > symbol.span.endLine) continue;
    const size = symbol.span.endLine - symbol.span.startLine;
    if (best === null || size < best.size) {
      best = { q: symbol.qualifiedName, size };
    }
  }
  return best !== null ? best.q : null;
}

export function matchInPath(paths: readonly string[], filter: string): boolean {
  if (filter.length === 0) return true;
  const norm = filter.replace(/\/+$/, "");
  for (const p of paths) {
    if (p === norm || p.startsWith(`${norm}/`)) return true;
  }
  return false;
}
