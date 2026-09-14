import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveCacheDir, workspaceDirFor } from "../cache/cache.js";
import { indexFormatVersion, type LanguageId, type OsnovaIndex } from "../types.js";
import { isRecord, LspClient, resolveLspLimits } from "./client.js";
import { sourceText } from "../index/scan.js";
import { workspaceIdentity } from "../index/workspace.js";
import type { LspCacheOptions, LspDiagnostic, LspEnrichmentResult, LspLaunchSpec, LspLocation, LspPolicy, LspPosition, LspQuery, LspQueryResult, LspRange, LspRefreshOptions } from "./types.js";

export const lspEnrichmentLimits = Object.freeze({ maxServers: 16, maxQueries: 256, maxLocations: 256, maxFiles: 4_096, maxSourceBytes: 67_108_864, maxSidecarBytes: 16_777_216, refreshTimeoutMs: 30_000 });
const languageIds: readonly LanguageId[] = ["typescript", "tsx", "javascript", "python", "go", "rust", "java", "c_sharp"];
const protocolLanguages: Record<LanguageId, string> = { typescript: "typescript", tsx: "typescriptreact", javascript: "javascript", python: "python", go: "go", rust: "rust", java: "java", c_sharp: "csharp" };
const queues = new Map<string, Promise<unknown>>();

function digest(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

function errorCode(error: unknown, fallback: string): string {
  return error instanceof Error && /^[a-z0-9-]{1,64}$/.test(error.message) ? error.message : fallback;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => isRecord(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
}

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function sourcePath(root: string, file: string): string {
  root = workspaceIdentity(root);
  if (!file || path.isAbsolute(file) || file.includes("\\") || file.split("/").some((part) => part === ".." || part === "." || part === "")) throw new Error("invalid-source-path");
  const absolute = path.resolve(root, file);
  if (!within(root, absolute)) throw new Error("invalid-source-path");
  return absolute;
}

function position(value: unknown): value is LspPosition {
  return isRecord(value) && Number.isSafeInteger(value.line) && Number.isSafeInteger(value.character) && (value.line as number) >= 0 && (value.character as number) >= 0;
}

function range(value: unknown): value is LspRange {
  return isRecord(value) && position(value.start) && position(value.end) && (value.start.line < value.end.line || (value.start.line === value.end.line && value.start.character <= value.end.character));
}

function query(value: unknown): value is LspQuery {
  return isRecord(value) && typeof value.file === "string" && typeof value.sourceHash === "string" && /^[a-f0-9]{64}$/.test(value.sourceHash) && (value.method === "references" || value.method === "definition") && position(value.position);
}

function validatePolicy(root: string, value: unknown): LspPolicy {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.servers) || value.servers.length > lspEnrichmentLimits.maxServers) throw new Error("invalid-policy");
  const ids = new Set<string>();
  for (const server of value.servers as unknown[]) {
    if (!isRecord(server) || typeof server.id !== "string" || !/^[a-zA-Z0-9_.-]{1,64}$/.test(server.id) || ids.has(server.id) || typeof server.workspace !== "string" || !path.isAbsolute(server.workspace) || !within(root, workspaceIdentity(server.workspace)) || typeof server.executable !== "string" || !path.isAbsolute(server.executable) || !Array.isArray(server.languages) || !server.languages.length || !server.languages.every((l: unknown) => languageIds.includes(l as LanguageId)) || (server.args !== undefined && (!Array.isArray(server.args) || server.args.length > 128 || !server.args.every((a: unknown) => typeof a === "string" && a.length <= 8_192)))) throw new Error("invalid-policy");
    ids.add(server.id);
  }
  if (value.limits !== undefined && !isRecord(value.limits)) throw new Error("invalid-policy");
  resolveLspLimits(value.limits ?? {});
  if (Buffer.byteLength(canonical(value)) > 131_072) throw new Error("policy-byte-limit");
  return JSON.parse(canonical(value)) as LspPolicy;
}

function identity(index: OsnovaIndex, options: LspCacheOptions): { root: string; workspaceHash: string; baseGeneration: string } {
  const root = workspaceIdentity(index.root);
  const workspaceHash = digest(canonical([...index.files.values()].map((file) => [file.path, file.hash, file.language, file.diagnostics ?? []]).sort((a, b) => String(a[0]) < String(b[0]) ? -1 : 1)));
  return { root, workspaceHash, baseGeneration: options.baseGeneration ?? digest(canonical([indexFormatVersion, root, workspaceHash, index.diagnostics ?? []])) };
}

function directory(root: string, options: LspCacheOptions): string {
  return path.join(workspaceDirFor(path.resolve(resolveCacheDir(options.cacheDir)), root), "lsp");
}

async function boundedRead(file: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("read-byte-limit");
    const bytes = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes || total !== stat.size) throw new Error("source-changed-during-read");
    return bytes.subarray(0, total);
  } finally { await handle.close(); }
}

async function readStored(file: string, diagnostics: LspDiagnostic[]): Promise<unknown> {
  try { return JSON.parse((await boundedRead(file, lspEnrichmentLimits.maxSidecarBytes)).toString("utf8")) as unknown; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.push({ code: "cache-unreadable" });
    return undefined;
  }
}

async function safeDirectory(root: string, options: LspCacheOptions): Promise<string> {
  const cache = path.resolve(resolveCacheDir(options.cacheDir));
  await fs.mkdir(cache, { recursive: true });
  const realCache = await fs.realpath(cache);
  let current = realCache;
  for (const part of [path.basename(workspaceDirFor(cache, root)), "lsp"]) {
    current = path.join(current, part);
    await fs.mkdir(current).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    if ((await fs.lstat(current)).isSymbolicLink() || !within(realCache, await fs.realpath(current))) throw new Error("cache-path-escape");
  }
  return current;
}

async function store(root: string, name: "policy.json" | "results.json", value: unknown, options: LspCacheOptions): Promise<void> {
  const bytes = Buffer.from(canonical(value));
  if (bytes.length > lspEnrichmentLimits.maxSidecarBytes) throw new Error("sidecar-byte-limit");
  const dir = await safeDirectory(root, options);
  const temporary = path.join(dir, `${name}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, path.join(dir, name));
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

async function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  queues.set(key, current);
  try { return await current; } finally { if (queues.get(key) === current) queues.delete(key); }
}

async function withWriteLock<T>(root: string, options: LspCacheOptions, operation: () => Promise<T>): Promise<T> {
  let dir: string;
  try { dir = await safeDirectory(root, options); } catch { throw new Error("cache-unavailable"); }
  const lockPath = path.join(dir, "writer.lock");
  const lock = await fs.open(lockPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => { throw new Error(error.code === "EEXIST" ? "cache-busy" : "cache-unavailable"); });
  let result: T | undefined;
  let operationError: unknown;
  try { result = await operation(); } catch (error) { operationError = error; }
  let cleanupError: unknown;
  try { await lock.close(); } catch (error) { cleanupError = error; }
  try { await fs.unlink(lockPath); } catch (error) { cleanupError ??= error; }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw new Error("cache-unavailable", { cause: cleanupError });
  return result as T;
}

export async function configureLspEnrichment(root: string, policy: LspPolicy, options: LspCacheOptions = {}): Promise<void> {
  root = workspaceIdentity(root);
  const validated = validatePolicy(root, policy);
  await serialized(directory(root, options), () => withWriteLock(root, options, () => store(root, "policy.json", validated, options)));
}

async function verifySources(index: OsnovaIndex): Promise<LspDiagnostic[]> {
  const diagnostics: LspDiagnostic[] = [];
  if (index.files.size > lspEnrichmentLimits.maxFiles) return [{ code: "source-file-limit" }];
  let total = 0;
  const root = await fs.realpath(index.root).catch(() => undefined);
  if (!root) return [{ code: "source-unavailable" }];
  for (const [file, card] of index.files) {
    try {
      const absolute = sourcePath(index.root, file);
      if (!within(root, await fs.realpath(absolute))) throw new Error("source-path-escape");
      const bytes = await boundedRead(absolute, 1_000_000);
      total += bytes.length;
      if (total > lspEnrichmentLimits.maxSourceBytes) return [{ code: "source-byte-limit" }];
      const text = sourceText(bytes) ?? "";
      if (card.path !== file || digest(bytes) !== card.hash || card.text !== text) diagnostics.push({ code: "stale-source", file });
    } catch { diagnostics.push({ code: "stale-source", file }); }
  }
  return diagnostics;
}

function validPosition(text: string, pos: LspPosition): boolean {
  const line = text.split(/\r\n|\r|\n/)[pos.line];
  return line !== undefined && pos.character <= line.length;
}

function matching(server: LspLaunchSpec, index: OsnovaIndex, q: LspQuery): boolean {
  const card = index.files.get(q.file);
  return card !== undefined && card.language !== "fallback" && server.languages.includes(card.language) && within(workspaceIdentity(server.workspace), sourcePath(index.root, q.file));
}

function queryKey(q: LspQuery): string { return canonical([q.file, q.method, q.position]); }

function storedResult(value: unknown): value is LspQueryResult {
  if (!isRecord(value) || !query(value.query) || !languageIds.includes(value.language as LanguageId) || typeof value.baseGeneration !== "string" || typeof value.workspaceHash !== "string" || (value.status !== "complete" && value.status !== "partial") || !Array.isArray(value.locations) || value.locations.length > lspEnrichmentLimits.maxLocations || !isRecord(value.evidence)) return false;
  const evidence = value.evidence;
  return evidence.source === "lsp" && evidence.claim === "server-locations" && typeof evidence.serverId === "string" && typeof evidence.launchHash === "string" && evidence.method === `textDocument/${value.query.method}` && evidence.positionEncoding === "utf-16" && evidence.dependencyScope === "indexed-workspace" && value.locations.every((location: unknown) => isRecord(location) && typeof location.file === "string" && typeof location.sourceHash === "string" && range(location.range));
}

async function load(index: OsnovaIndex, options: LspCacheOptions, override?: LspPolicy, includeStoredDiagnostics = true): Promise<LspEnrichmentResult> {
  const id = identity(index, options);
  const diagnostics: LspDiagnostic[] = [];
  const dir = directory(id.root, options);
  const rawPolicy = override ?? await readStored(path.join(dir, "policy.json"), diagnostics);
  let policy: LspPolicy | null = null;
  if (rawPolicy !== undefined) {
    try { policy = validatePolicy(id.root, rawPolicy); } catch { diagnostics.push({ code: "invalid-policy" }); }
  }
  const raw = await readStored(path.join(dir, "results.json"), diagnostics);
  const queries: LspQuery[] = [];
  const results: LspQueryResult[] = [];
  if (raw !== undefined) {
    if (!isRecord(raw) || raw.version !== 1 || raw.root !== id.root || !Array.isArray(raw.queries) || raw.queries.length > lspEnrichmentLimits.maxQueries || !raw.queries.every(query) || !Array.isArray(raw.results) || raw.results.length > lspEnrichmentLimits.maxQueries * lspEnrichmentLimits.maxServers || !raw.results.every(storedResult)) diagnostics.push({ code: "invalid-sidecar" });
    else {
      queries.push(...raw.queries as LspQuery[]);
      if (Array.isArray(raw.diagnostics) && raw.diagnostics.length <= 8_192 && raw.diagnostics.every((d: unknown) => isRecord(d) && typeof d.code === "string" && /^[a-z0-9-]{1,64}$/.test(d.code) && (d.file === undefined || typeof d.file === "string") && (d.serverId === undefined || typeof d.serverId === "string"))) { if (includeStoredDiagnostics) diagnostics.push(...raw.diagnostics as LspDiagnostic[]); }
      else diagnostics.push({ code: "invalid-sidecar" });
      const sameGeneration = raw.baseGeneration === id.baseGeneration && raw.workspaceHash === id.workspaceHash;
      if (!sameGeneration) diagnostics.push({ code: "stale-generation" });
      for (const result of raw.results as LspQueryResult[]) {
        const server = policy?.servers.find((s) => s.id === result.evidence.serverId);
        const card = index.files.get(result.query.file);
        if (!sameGeneration || result.baseGeneration !== id.baseGeneration || result.workspaceHash !== id.workspaceHash || !server || digest(canonical(server)) !== result.evidence.launchHash || !card || card.hash !== result.query.sourceHash || card.language !== result.language || !matching(server, index, result.query) || !validPosition(card.text, result.query.position) || !result.locations.every((location) => { const target = index.files.get(location.file); return target?.hash === location.sourceHash && validPosition(target.text, location.range.start) && validPosition(target.text, location.range.end); })) continue;
        results.push(result);
      }
      if (raw.results.length !== results.length && sameGeneration) diagnostics.push({ code: "stale-evidence" });
    }
  }
  const sourceDiagnostics = results.length ? await verifySources(index) : [];
  if (sourceDiagnostics.length) { results.length = 0; diagnostics.push(...sourceDiagnostics); }
  return { version: 1, ...id, policy, status: results.length ? (diagnostics.length || results.some((r) => r.status === "partial") ? "partial" : "complete") : "unavailable", queries, results, diagnostics, reused: 0 };
}

export async function loadLspEnrichment(index: OsnovaIndex, options: LspCacheOptions = {}): Promise<LspEnrichmentResult> {
  return serialized(directory(workspaceIdentity(index.root), options), () => load(index, options));
}

function locations(raw: unknown, index: OsnovaIndex): { locations: LspLocation[]; partial: boolean } {
  const values = raw === null ? [] : Array.isArray(raw) ? raw : [raw];
  const found = new Map<string, LspLocation>();
  let partial = values.length > lspEnrichmentLimits.maxLocations;
  for (const value of values.slice(0, lspEnrichmentLimits.maxLocations)) {
    try {
      if (!isRecord(value)) throw new Error();
      const uri = value.uri ?? value.targetUri;
      const span = value.range ?? value.targetSelectionRange;
      if (typeof uri !== "string" || !range(span)) throw new Error();
      const absolute = workspaceIdentity(fileURLToPath(uri));
      const root = workspaceIdentity(index.root);
      if (!within(root, absolute)) throw new Error();
      const file = path.relative(root, absolute).split(path.sep).join("/");
      const card = index.files.get(file);
      if (!card || !validPosition(card.text, span.start) || !validPosition(card.text, span.end)) throw new Error();
      const location = { file, range: { start: { line: span.start.line, character: span.start.character }, end: { line: span.end.line, character: span.end.character } }, sourceHash: card.hash };
      found.set(canonical(location), location);
    } catch { partial = true; }
  }
  return { locations: [...found.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, location]) => location), partial };
}

async function refresh(index: OsnovaIndex, options: LspRefreshOptions): Promise<LspEnrichmentResult> {
    const previous = await load(index, options, options.policy, false);
    if (options.enabled !== true) return { ...previous, status: "disabled" };
    const policy = previous.policy;
    const diagnostics = previous.diagnostics.filter((d) => ["cache-unreadable", "invalid-policy", "invalid-sidecar"].includes(d.code));
    if (!policy) return { ...previous, status: "unavailable", diagnostics: [...diagnostics, { code: "no-policy" }] };
    const sourceDiagnostics = await verifySources(index);
    if (sourceDiagnostics.length) return { ...previous, results: [], status: "unavailable", diagnostics: [...diagnostics, ...sourceDiagnostics] };
    const allQueries = new Map(previous.queries.filter((q) => {
      const card = index.files.get(q.file);
      if (card?.hash === q.sourceHash && validPosition(card.text, q.position)) return true;
      if (!(options.queries ?? []).some((replacement) => card !== undefined && query(replacement) && queryKey(replacement) === queryKey(q) && replacement.sourceHash === card.hash && validPosition(card.text, replacement.position))) diagnostics.push({ code: "stale-query", file: q.file });
      return false;
    }).map((q) => [queryKey(q), q]));
    for (const q of options.queries ?? []) {
      if (!query(q)) { diagnostics.push({ code: "invalid-query" }); continue; }
      const card = index.files.get(q.file);
      if (!card || card.hash !== q.sourceHash || !validPosition(card.text, q.position)) { diagnostics.push({ code: "stale-query", file: q.file }); continue; }
      if (!allQueries.has(queryKey(q)) && allQueries.size >= lspEnrichmentLimits.maxQueries) { diagnostics.push({ code: "query-limit" }); break; }
      allQueries.set(queryKey(q), q);
    }
    const queries = [...allQueries.values()].sort((a, b) => queryKey(a) < queryKey(b) ? -1 : 1);
    const validQueries = queries.filter((q) => {
      try { sourcePath(index.root, q.file); } catch { diagnostics.push({ code: "invalid-query", file: q.file }); return false; }
      const card = index.files.get(q.file);
      if (!card || card.hash !== q.sourceHash || !validPosition(card.text, q.position)) { diagnostics.push({ code: "stale-query", file: q.file }); return false; }
      if (!policy.servers.some((server) => matching(server, index, q))) { diagnostics.push({ code: "no-server", file: q.file }); return false; }
      return true;
    });
    const results: LspQueryResult[] = [];
    let reused = 0;
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const timer = setTimeout(abort, lspEnrichmentLimits.refreshTimeoutMs);
    try {
      for (const server of policy.servers) {
        const pending: LspQuery[] = [];
        for (const q of validQueries.filter((q) => matching(server, index, q))) {
          const old = previous.results.find((r) => r.evidence.serverId === server.id && queryKey(r.query) === queryKey(q) && r.query.sourceHash === q.sourceHash && r.status === "complete");
          if (old) { results.push(old); reused += 1; } else pending.push(q);
        }
        if (!pending.length) continue;
        if (controller.signal.aborted) { diagnostics.push({ code: "cancelled", serverId: server.id }); continue; }
        let client: LspClient | undefined;
        try {
          const cache = await safeDirectory(previous.root, options).catch(() => { throw new Error("cache-unavailable"); });
          client = new LspClient(server, cache, policy.limits);
          const capabilities = await client.initialize(controller.signal);
          for (const card of index.files.values()) {
            if (card.language === "fallback" || !server.languages.includes(card.language) || !within(workspaceIdentity(server.workspace), sourcePath(index.root, card.path))) continue;
            client.notify("textDocument/didOpen", { textDocument: { uri: pathToFileURL(sourcePath(index.root, card.path)).href, languageId: protocolLanguages[card.language], version: 1, text: card.text } });
          }
          for (const q of pending) {
            if (controller.signal.aborted) { diagnostics.push({ code: "cancelled", serverId: server.id, file: q.file }); continue; }
            if (capabilities[`${q.method}Provider`] !== true && !isRecord(capabilities[`${q.method}Provider`])) { diagnostics.push({ code: "method-unavailable", serverId: server.id, file: q.file }); continue; }
            try {
              const method = `textDocument/${q.method}` as const;
              const response = await client.request(method, { textDocument: { uri: pathToFileURL(sourcePath(index.root, q.file)).href }, position: q.position, ...(q.method === "references" ? { context: { includeDeclaration: true } } : {}) }, controller.signal);
              const parsed = locations(response, index);
              if (parsed.partial) diagnostics.push({ code: "locations-partial", serverId: server.id, file: q.file });
              results.push({ query: q, language: index.files.get(q.file)!.language as LanguageId, baseGeneration: previous.baseGeneration, workspaceHash: previous.workspaceHash, status: parsed.partial ? "partial" : "complete", locations: parsed.locations, evidence: { source: "lsp", claim: "server-locations", serverId: server.id, launchHash: digest(canonical(server)), method, positionEncoding: "utf-16", dependencyScope: "indexed-workspace" } });
            } catch (error) { diagnostics.push({ code: errorCode(error, "request-failed"), serverId: server.id, file: q.file }); }
          }
        } catch (error) { diagnostics.push({ code: errorCode(error, "server-unavailable"), serverId: server.id }); }
        finally { await client?.close(); }
      }
    } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
    for (const old of previous.results.filter((r) => r.status === "partial")) {
      if (!validQueries.some((q) => queryKey(q) === queryKey(old.query) && q.sourceHash === old.query.sourceHash)) continue;
      const replacement = results.findIndex((r) => r.evidence.serverId === old.evidence.serverId && queryKey(r.query) === queryKey(old.query));
      if (replacement === -1) { results.push(old); reused += 1; }
      else if (results[replacement]!.status === "partial") {
        const current = results[replacement]!;
        const union = new Map([...old.locations, ...current.locations].map((location) => [canonical(location), location]));
        results[replacement] = { ...current, locations: [...union.values()].slice(0, lspEnrichmentLimits.maxLocations) };
      }
    }
    const after = await verifySources(index);
    if (identity(index, options).workspaceHash !== previous.workspaceHash) after.push({ code: "stale-generation" });
    if (after.length) { results.length = 0; reused = 0; diagnostics.push(...after); }
    const result: LspEnrichmentResult = { ...previous, queries, results, reused, diagnostics, status: diagnostics.length || results.some((r) => r.status === "partial") ? (results.length ? "partial" : "unavailable") : "complete" };
    try {
      await store(previous.root, "results.json", { version: 1, root: previous.root, baseGeneration: previous.baseGeneration, workspaceHash: previous.workspaceHash, queries, results, diagnostics }, options);
    } catch { diagnostics.push({ code: "cache-write-failed" }); return { ...result, status: results.length ? "partial" : "unavailable" }; }
    return result;
}

export async function refreshLspEnrichment(index: OsnovaIndex, options: LspRefreshOptions = {}): Promise<LspEnrichmentResult> {
  const root = workspaceIdentity(index.root);
  return serialized(directory(root, options), async () => {
    if (options.enabled !== true) return { ...await load(index, options, options.policy), status: "disabled" };
    try { return await withWriteLock(root, options, () => refresh(index, options)); }
    catch (error) {
      const previous = await load(index, options, options.policy);
      return { ...previous, status: previous.results.length ? "partial" : "unavailable", diagnostics: [...previous.diagnostics, { code: errorCode(error, "enrichment-failed") }] };
    }
  });
}
