import type { CardLanguage, FileCard, OsnovaIndex, OsnovaSymbol, RouteSite } from "../types.js";

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "of", "in", "to", "for", "and", "or", "how",
  "do", "does", "what", "where", "which", "this", "that", "with", "on", "as",
  "at", "by", "from", "it", "its", "be", "can", "was", "were", "will", "not",
]);

const OTHER = 0, UPPER = 1, LOWER = 2, DIGIT = 3;
const ASCII_CLASS = new Uint8Array(128);
for (let code = 0; code < 128; code += 1) {
  ASCII_CLASS[code] = code >= 65 && code <= 90 ? UPPER : code >= 97 && code <= 122 ? LOWER : code >= 48 && code <= 57 ? DIGIT : OTHER;
}

// Splits a camel hump, lowercases, and keeps runs of letters and digits. A character outside ASCII can lowercase
// into letters (`İ` becomes `i` and a combining dot), so text that holds one falls back to the regular expressions.
export function tokenizeUnicode(text: string): string[] {
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

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const end = text.length;
  let start = -1;
  let run = -1;
  let runTokens = 0;
  let previous = OTHER;
  const take = (from: number, to: number): void => {
    const length = to - from;
    if (length < 2 || length > 64) return;
    const token = text.slice(from, to).toLowerCase();
    if (STOPWORDS.has(token)) return;
    out.push(token);
  };
  for (let i = 0; i < end; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 128) {
      // Text before the current letter-and-digit run ends on a separator, so both tokenizers agree on it and
      // only the rest needs the regular expressions.
      if (run >= 0) out.length = runTokens;
      for (const token of tokenizeUnicode(text.slice(run >= 0 ? run : i))) out.push(token);
      return out;
    }
    const current = ASCII_CLASS[code] ?? OTHER;
    if (current === OTHER) {
      if (start >= 0) { take(start, i); start = -1; }
      run = -1;
      previous = OTHER;
      continue;
    }
    if (start < 0) { start = i; run = i; runTokens = out.length; previous = current; continue; }
    let split = false;
    if (current === UPPER) {
      if (previous === LOWER || previous === DIGIT) split = true;
      else if (previous === UPPER) {
        const next = i + 1 < end ? text.charCodeAt(i + 1) : 128;
        if (next < 128 && ASCII_CLASS[next] === LOWER) split = true;
      }
    }
    if (split) { take(start, i); start = i; }
    previous = current;
  }
  if (start >= 0) take(start, end);
  return out;
}

const STOPWORD_MAX_LENGTH = Math.max(...[...STOPWORDS].map((word) => word.length));

// Counts what tokenize would return for every line of the text without building the tokens.
export function countTokens(text: string): number {
  let count = 0;
  const end = text.length;
  let start = -1;
  let run = -1;
  let runCount = 0;
  let previous = OTHER;
  const take = (from: number, to: number): void => {
    const length = to - from;
    if (length < 2 || length > 64) return;
    if (length <= STOPWORD_MAX_LENGTH && STOPWORDS.has(text.slice(from, to).toLowerCase())) return;
    count += 1;
  };
  for (let i = 0; i < end; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 128) {
      if (run >= 0) count = runCount;
      const newline = text.indexOf("\n", i);
      const lineEnd = newline < 0 ? end : newline;
      count += tokenizeUnicode(text.slice(run >= 0 ? run : i, lineEnd)).length;
      start = -1;
      run = -1;
      previous = OTHER;
      i = lineEnd;
      continue;
    }
    const current = ASCII_CLASS[code] ?? OTHER;
    if (current === OTHER) {
      if (start >= 0) { take(start, i); start = -1; }
      run = -1;
      previous = OTHER;
      continue;
    }
    if (start < 0) { start = i; run = i; runCount = count; previous = current; continue; }
    let split = false;
    if (current === UPPER) {
      if (previous === LOWER || previous === DIGIT) split = true;
      else if (previous === UPPER) {
        const next = i + 1 < end ? text.charCodeAt(i + 1) : 128;
        if (next < 128 && ASCII_CLASS[next] === LOWER) split = true;
      }
    }
    if (split) { take(start, i); start = i; }
    previous = current;
  }
  if (start >= 0) take(start, end);
  return count;
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
  readonly route?: { readonly method: string; readonly path: string | undefined; readonly line: number } | undefined;
  readonly body: Map<string, number>;
  length: number;
}

export interface QueryContext {
  readonly documents: readonly SearchDocument[];
  readonly lines: ReadonlyMap<string, readonly string[]>;
  readonly df: ReadonlyMap<string, number>;
  readonly averageLength: number;
  readonly documentCount: number;
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
  readonly documentTerms: readonly ReadonlySet<string>[];
  readonly length: number;
}

const fileCache = new Map<string, FileDocuments>();
const contextCache = new WeakMap<OsnovaIndex, QueryContext>();

const cacheKey = (card: FileCard): string => `${card.path}\0${card.hash}\0${card.language}\0${card.symbols.length}\0${card.routes?.length ?? 0}`;

const localName = (symbol: OsnovaSymbol | null): string => symbol?.qualifiedName.split("#").slice(1).join("#") ?? "";

const sortedDefinitions = (card: FileCard): OsnovaSymbol[] => [...card.symbols].sort((a, b) => a.span.startLine - b.span.startLine ||
  a.span.startCol - b.span.startCol || b.span.endLine - a.span.endLine || b.span.endCol - a.span.endCol);

// One document per route registration, so "GET /users" ranks the site and its handler. The verb and
// path are literal in this file, so the entry stays valid under the card's own cache key; the handler
// symbol is attached only when it lives in this file.
// A controller prefix and a method path declared in the same file compose into one label at query
// time only (`cats` + `:id` is searchable as `/cats/:id`); the artifact keeps the two sites apart.
function routeLabels(card: FileCard): { site: RouteSite; name: string; signature: string }[] {
  const routes = card.routes ?? [];
  const prefixOf = (site: RouteSite): string | undefined => {
    if (site.handler === undefined || !site.handler.includes(".")) return undefined;
    const owner = site.handler.slice(0, site.handler.lastIndexOf("."));
    return routes.find((mount) => mount.method === "ANY" && mount.handler === owner && mount.path !== undefined)?.path;
  };
  return routes.map((site) => {
    const prefix = site.path === undefined ? undefined : prefixOf(site);
    const composed = prefix === undefined ? undefined : `/${prefix}/${site.path ?? ""}`.replace(/\/+/g, "/");
    const label = `${site.method} ${site.path ?? ""} ${composed ?? ""}`;
    return { site, name: label, signature: `${label} ${site.handler ?? ""} route` };
  });
}

function buildFileDocuments(file: string, card: FileCard): FileDocuments {
  const lines = card.text.length > 0 ? card.text.split("\n") : [];
  const pathTokens = new Set(tokenize(file));
  const create = (symbol: OsnovaSymbol | null): SearchDocument => {
    const docRange = symbol === null ? null : documentationRange(lines, symbol, card.language);
    return {
      file, symbol, path: pathTokens,
      name: new Set(tokenize(localName(symbol))),
      signature: new Set(tokenize(symbol?.signature ?? "")),
      documentation: new Set(tokenize(docRange === null ? "" : lines.slice(docRange.start - 1, docRange.end).join("\n"))),
      documentationRange: docRange, ranges: [], body: new Map(), length: 0,
    };
  };
  const module = create(null);
  const definitions = sortedDefinitions(card).map(create);
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
  const routeDocuments = routeLabels(card).map(({ site, name, signature }) => {
    const symbol = site.handler === undefined ? null : card.symbols.find((candidate) => candidate.qualifiedName === `${file}#${site.handler}`) ?? null;
    const tokens = tokenize(lines[site.line - 1] ?? "");
    return {
      file, symbol, path: pathTokens,
      name: new Set(tokenize(name)),
      signature: new Set(tokenize(signature)),
      documentation: new Set<string>(), documentationRange: null,
      ranges: [{ start: site.line, end: site.line }],
      body: new Map(tokens.map((token) => [token, tokens.filter((other) => other === token).length])), length: tokens.length,
      route: { method: site.method, path: site.path, line: site.line },
    } satisfies SearchDocument;
  });
  const documents = [module, ...definitions, ...routeDocuments];
  const documentTerms: Set<string>[] = [];
  let length = 0;
  for (const document of documents) {
    length += document.length;
    documentTerms.push(new Set([...document.name, ...document.signature, ...document.documentation, ...document.path, ...document.body.keys()]));
  }
  return { documents, lines, documentTerms, length };
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
    for (const terms of entry.documentTerms) {
      for (const term of terms) df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  for (const key of fileCache.keys()) {
    if (!live.has(key) && fileCache.size > live.size * 2) fileCache.delete(key);
  }
  const ctx: QueryContext = { documents, lines: fileLines, df, documentCount: documents.length,
    averageLength: Math.max(1, totalLength / Math.max(1, documents.length)) };
  contextCache.set(index, ctx);
  return ctx;
}

const lengthCache = new Map<string, number>();

function fileTokenLength(card: FileCard): number {
  if (card.text.length === 0) return 0;
  const routes = card.routes ?? [];
  if (routes.length === 0) return countTokens(card.text);
  const lines = card.text.split("\n");
  return routes.reduce((length, site) => length + countTokens(lines[site.line - 1] ?? ""), countTokens(card.text));
}

// How many of the file's documents (module, definitions, routes) hold each term, without building them.
// A term reaches a document through the path, a name, a signature, a routed label, a documentation line
// or a body line, and every one of those holds the term as a substring once lowercased.
function termDocumentCounts(file: string, card: FileCard, terms: readonly string[]): number[] {
  const documentCount = 1 + card.symbols.length + (card.routes?.length ?? 0);
  const pathTokens = new Set(tokenize(file));
  let haystack: string | undefined;
  let parts: { lines: string[]; lower: string[]; definitions: OsnovaSymbol[]; routes: ReturnType<typeof routeLabels> } | undefined;
  return terms.map((term) => {
    if (pathTokens.has(term)) return documentCount;
    haystack ??= [card.text, ...card.symbols.flatMap((symbol) => [symbol.qualifiedName, symbol.signature]),
      ...(card.routes ?? []).flatMap((site) => [site.method, site.path ?? "", site.handler ?? ""]), card.routes?.length ? "route" : ""].join("\n").toLowerCase();
    if (!haystack.includes(term)) return 0;
    if (parts === undefined) {
      const lines = card.text.length > 0 ? card.text.split("\n") : [];
      parts = { lines, lower: lines.map((line) => line.toLowerCase()), definitions: sortedDefinitions(card), routes: routeLabels(card) };
    }
    const { lines, lower, definitions, routes } = parts;
    const termLines = new Set<number>();
    for (let i = 0; i < lines.length; i += 1) {
      if (lower[i]!.includes(term) && tokenize(lines[i]!).includes(term)) termLines.add(i + 1);
    }
    const holders = new Set<number>();
    for (const line of termLines) {
      let owner = -1;
      for (let k = 0; k < definitions.length; k += 1) {
        const span = definitions[k]!.span;
        if (span.startLine > line) break;
        if (span.endLine >= line) owner = k;
      }
      holders.add(owner);
    }
    definitions.forEach((symbol, k) => {
      if (holders.has(k)) return;
      if (tokenize(localName(symbol)).includes(term) || tokenize(symbol.signature).includes(term)) {
        holders.add(k);
        return;
      }
      if (termLines.size === 0) return;
      const range = documentationRange(lines, symbol, card.language);
      if (range === null) return;
      for (let line = range.start; line <= range.end; line += 1) {
        if (termLines.has(line)) {
          holders.add(k);
          return;
        }
      }
    });
    routes.forEach(({ site, name, signature }, r) => {
      if (termLines.has(site.line) || tokenize(name).includes(term) || tokenize(signature).includes(term)) holders.add(definitions.length + r);
    });
    return holders.size;
  });
}

// The context for a question scoped to a path: documents for files inside the scope only, with the
// document frequency of each query term, the document count and the average length still taken over
// the whole repository, so every score equals the one the unscoped context gives. When the whole
// context is already built it is returned as is, so callers still filter documents by the scope.
export function scopedQueryContext(index: OsnovaIndex, scope: string, terms: readonly string[]): QueryContext {
  const cached = contextCache.get(index);
  if (cached !== undefined || scope.length === 0) return cached ?? queryContext(index);
  const documents: SearchDocument[] = [];
  const fileLines = new Map<string, readonly string[]>();
  const counts = terms.map(() => 0);
  let documentCount = 0;
  let totalLength = 0;
  const live = new Set<string>();
  for (const [file, card] of index.files) {
    const key = cacheKey(card);
    live.add(key);
    const inside = matchInPath([file], scope);
    let entry = fileCache.get(key);
    if (entry === undefined && inside) {
      entry = buildFileDocuments(file, card);
      fileCache.set(key, entry);
    }
    if (entry !== undefined) {
      if (inside) {
        documents.push(...entry.documents);
        fileLines.set(file, entry.lines);
      }
      documentCount += entry.documents.length;
      totalLength += entry.length;
      for (let i = 0; i < terms.length; i += 1) {
        for (const held of entry.documentTerms) if (held.has(terms[i]!)) counts[i]! += 1;
      }
      continue;
    }
    documentCount += 1 + card.symbols.length + (card.routes?.length ?? 0);
    let length = lengthCache.get(key);
    if (length === undefined) {
      length = fileTokenLength(card);
      lengthCache.set(key, length);
    }
    totalLength += length;
    termDocumentCounts(file, card, terms).forEach((count, i) => { counts[i]! += count; });
  }
  for (const key of lengthCache.keys()) {
    if (!live.has(key) && lengthCache.size > live.size * 2) lengthCache.delete(key);
  }
  const df = new Map<string, number>();
  terms.forEach((term, i) => { if (counts[i]! > 0) df.set(term, counts[i]!); });
  return { documents, lines: fileLines, df, documentCount, averageLength: Math.max(1, totalLength / Math.max(1, documentCount)) };
}

export function resetQueryCaches(): void {
  fileCache.clear();
  lengthCache.clear();
}

export function fileDocumentsCached(index: OsnovaIndex, file: string): boolean {
  const card = index.files.get(file);
  return card !== undefined && fileCache.has(cacheKey(card));
}

export function idf(ctx: QueryContext, term: string): number {
  const frequency = ctx.df.get(term);
  return frequency === undefined ? 0 : Math.log(1 + (ctx.documentCount - frequency + 0.5) / (frequency + 0.5));
}

export function matchInPath(paths: readonly string[], filter: string): boolean {
  if (filter.length === 0) return true;
  const norm = filter.replace(/\/+$/, "");
  for (const p of paths) {
    if (p === norm || p.startsWith(`${norm}/`)) return true;
  }
  return false;
}
