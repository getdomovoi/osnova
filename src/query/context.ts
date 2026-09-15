import type { CardLanguage, FileCard, OsnovaIndex, OsnovaSymbol } from "../types.js";

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "of", "in", "to", "for", "and", "or", "how",
  "do", "does", "what", "where", "which", "this", "that", "with", "on", "as",
  "at", "by", "from", "it", "its", "be", "can", "was", "were", "will", "not",
]);

export function tokenize(text: string): string[] {
  const camelSplit = text.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const raw = camelSplit.toLowerCase().split(/[^a-z0-9]+/);
  const out: string[] = [];
  for (const token of raw) {
    if (token.length < 2 || token.length > 64) continue;
    if (STOPWORDS.has(token)) continue;
    out.push(token);
  }
  return out;
}

export interface SearchDocument {
  readonly file: string;
  readonly symbol: OsnovaSymbol | null;
  readonly name: ReadonlySet<string>;
  readonly signature: ReadonlySet<string>;
  readonly documentation: ReadonlySet<string>;
  readonly path: ReadonlySet<string>;
  readonly documentationRange: { start: number; end: number } | null;
  readonly ranges: Array<{ start: number; end: number }>;
  readonly body: Map<string, number>;
  length: number;
}

export interface QueryContext {
  readonly documents: readonly SearchDocument[];
  readonly lines: ReadonlyMap<string, readonly string[]>;
  readonly df: ReadonlyMap<string, number>;
  readonly averageLength: number;
}

function documentationRange(lines: readonly string[], symbol: OsnovaSymbol, language: CardLanguage): { start: number; end: number } | null {
  let start = symbol.span.startLine;
  for (let line = start - 1; line >= Math.max(1, symbol.span.startLine - 24); line -= 1) {
    if (!/^\s*(\/\/|\/\*|\*|#)/.test(lines[line - 1] ?? "")) break;
    start = line;
  }
  let end = symbol.span.startLine - 1;
  let headerEnd = symbol.span.startLine;
  if (language === "python") {
    while (headerEnd < Math.min(symbol.span.endLine, symbol.span.startLine + 24) &&
      !/:\s*(?:#.*)?$/.test(lines[headerEnd - 1] ?? "")) headerEnd += 1;
  }
  const firstBody = language === "python" ? lines[headerEnd]?.trim() ?? "" : "";
  const quote = firstBody.startsWith('"""') ? '"""' : firstBody.startsWith("'''") ? "'''" : null;
  if (quote !== null) {
    end = headerEnd + 1;
    if (!firstBody.slice(3).includes(quote)) {
      while (end < Math.min(symbol.span.endLine, headerEnd + 24)) {
        end += 1;
        if ((lines[end - 1] ?? "").includes(quote)) break;
      }
    }
  }
  return end >= start ? { start, end } : null;
}

interface FileDocuments {
  readonly documents: readonly SearchDocument[];
  readonly lines: readonly string[];
  readonly terms: ReadonlySet<string>;
  readonly length: number;
}

const fileCache = new Map<string, FileDocuments>();
const contextCache = new WeakMap<OsnovaIndex, QueryContext>();

const cacheKey = (card: FileCard): string => `${card.path}\0${card.hash}\0${card.language}`;

function buildFileDocuments(file: string, card: FileCard): FileDocuments {
  const lines = card.text.length > 0 ? card.text.split("\n") : [];
  const pathTokens = new Set(tokenize(file));
  const create = (symbol: OsnovaSymbol | null): SearchDocument => {
    const docRange = symbol === null ? null : documentationRange(lines, symbol, card.language);
    return {
      file, symbol, path: pathTokens,
      name: new Set(tokenize(symbol?.qualifiedName.split("#").slice(1).join("#") ?? "")),
      signature: new Set(tokenize(symbol?.signature ?? "")),
      documentation: new Set(tokenize(docRange === null ? "" : lines.slice(docRange.start - 1, docRange.end).join("\n"))),
      documentationRange: docRange, ranges: [], body: new Map(), length: 0,
    };
  };
  const module = create(null);
  const definitions = [...card.symbols].sort((a, b) => a.span.startLine - b.span.startLine ||
    a.span.startCol - b.span.startCol || b.span.endLine - a.span.endLine || b.span.endCol - a.span.endCol).map(create);
  let active: SearchDocument[] = [];
  let cursor = 0;
  for (let line = 1; line <= lines.length; line += 1) {
    while (cursor < definitions.length) {
      const doc = definitions[cursor];
      if (doc?.symbol === undefined || doc.symbol === null || doc.symbol.span.startLine > line) break;
      active.push(doc);
      cursor += 1;
    }
    active = active.filter((doc) => (doc.symbol?.span.endLine ?? 0) >= line);
    const owner = active[active.length - 1] ?? module;
    const last = owner.ranges[owner.ranges.length - 1];
    if (last?.end === line - 1) last.end = line;
    else owner.ranges.push({ start: line, end: line });
    const tokens = tokenize(lines[line - 1] ?? "");
    owner.length += tokens.length;
    for (const token of tokens) owner.body.set(token, (owner.body.get(token) ?? 0) + 1);
  }
  const documents = [module, ...definitions];
  const terms = new Set<string>();
  let length = 0;
  for (const document of documents) {
    length += document.length;
    for (const t of [...document.name, ...document.signature, ...document.documentation, ...document.path, ...document.body.keys()]) terms.add(t);
  }
  return { documents, lines, terms, length };
}

export function queryContext(index: OsnovaIndex): QueryContext {
  const cached = contextCache.get(index);
  if (cached !== undefined) return cached;
  const documents: SearchDocument[] = [];
  const fileLines = new Map<string, readonly string[]>();
  const df = new Map<string, number>();
  let totalLength = 0;
  const live = new Set<string>();
  for (const [file, card] of index.files) {
    const key = cacheKey(card);
    live.add(key);
    let entry = fileCache.get(key);
    if (entry === undefined) {
      entry = buildFileDocuments(file, card);
      fileCache.set(key, entry);
    }
    documents.push(...entry.documents);
    fileLines.set(file, entry.lines);
    totalLength += entry.length;
    for (const term of entry.terms) df.set(term, (df.get(term) ?? 0) + 1);
  }
  for (const key of fileCache.keys()) {
    if (!live.has(key) && fileCache.size > live.size * 2) fileCache.delete(key);
  }
  const ctx: QueryContext = { documents, lines: fileLines, df, averageLength: Math.max(1, totalLength / Math.max(1, documents.length)) };
  contextCache.set(index, ctx);
  return ctx;
}

export function fileDocumentsCached(index: OsnovaIndex, file: string): boolean {
  const card = index.files.get(file);
  return card !== undefined && fileCache.has(cacheKey(card));
}

export function idf(ctx: QueryContext, term: string): number {
  const frequency = ctx.df.get(term);
  return frequency === undefined ? 0 : Math.log(1 + (ctx.documents.length - frequency + 0.5) / (frequency + 0.5));
}

export function matchInPath(paths: readonly string[], filter: string): boolean {
  if (filter.length === 0) return true;
  const norm = filter.replace(/\/+$/, "");
  for (const p of paths) {
    if (p === norm || p.startsWith(`${norm}/`)) return true;
  }
  return false;
}
