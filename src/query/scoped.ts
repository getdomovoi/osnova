import { OsnovaIndexImpl } from "../index/indexImpl.js";
import type { AskHit, AskOptions, OsnovaIndex } from "../types.js";
import { askDetailed } from "./ask.js";
import { queryContext, tokenize } from "./context.js";
import type { SearchDocument } from "./context.js";
import { compareText, indexReceipt, sourceReceipt } from "./impact.js";
import type { IndexReceipt, SourceReceipt } from "./impact.js";

export interface PackageScope {
  readonly path: string;
  readonly name: string;
  readonly manifests: readonly { file: string; ecosystem: string; hash: string }[];
}

export interface ScopedAskHit extends AskHit {
  readonly scope: string;
  readonly receipt: SourceReceipt;
}

export interface ScopedAskResult {
  readonly hits: readonly ScopedAskHit[];
  readonly filesSearched: number;
  readonly scopes: readonly PackageScope[];
  readonly receipt: IndexReceipt;
  readonly omittedHits: number;
  readonly limitations: readonly string[];
  readonly alsoMatched?: readonly PackageScope[] | undefined;
}

export function normalizeScope(scope = ""): string {
  if (scope.startsWith("/")) throw new Error("osnova: scope must be a repository-relative path");
  const normalized = scope.replace(/^\.\//, "").replace(/\/+$/, "");
  if (normalized === "." || normalized === "") return "";
  if (normalized.startsWith("/") || normalized.includes("\\") || /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw new Error("osnova: scope must be a repository-relative path");
  }
  return normalized;
}

export function inScope(file: string, scope: string): boolean {
  return scope === "" || file === scope || file.startsWith(`${scope}/`);
}

function normalizeGlobBase(raw: string): string {
  let value = raw.trim();
  if (value.startsWith("./")) value = value.slice(2);
  value = value.replace(/\/+$/, "");
  return value;
}

function firstLevelChildDirectories(index: OsnovaIndex, base: string): Set<string> {
  const prefix = base === "" ? "" : `${base}/`;
  const children = new Set<string>();
  for (const path of index.files.keys()) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) continue;
    children.add(`${prefix}${rest.slice(0, slash)}`);
  }
  return children;
}

function directoryHasIndexedFile(index: OsnovaIndex, dir: string): boolean {
  const prefix = `${dir}/`;
  for (const path of index.files.keys()) if (path.startsWith(prefix)) return true;
  return false;
}

function workspaceGlobPatterns(index: OsnovaIndex): string[] {
  const patterns: string[] = [];
  const manifest = index.files.get("package.json");
  if (manifest !== undefined) {
    let json: unknown = null;
    try { json = JSON.parse(manifest.text); } catch { json = null; }
    const workspaces = json !== null && typeof json === "object" && "workspaces" in json ? json.workspaces : undefined;
    if (Array.isArray(workspaces)) {
      for (const entry of workspaces) if (typeof entry === "string") patterns.push(entry);
    } else if (workspaces !== null && typeof workspaces === "object" && workspaces !== undefined && "packages" in workspaces) {
      const packages = (workspaces as { packages: unknown }).packages;
      if (Array.isArray(packages)) for (const entry of packages) if (typeof entry === "string") patterns.push(entry);
    }
  }
  const yaml = index.files.get("pnpm-workspace.yaml");
  if (yaml !== undefined) {
    let inPackages = false;
    for (const line of yaml.text.split("\n")) {
      if (/^packages\s*:/.test(line)) { inPackages = true; continue; }
      if (!inPackages) continue;
      const item = line.match(/^\s*-\s*['"]?([^'"#]+)/);
      if (item?.[1] !== undefined) { patterns.push(item[1].trim()); continue; }
      if (/^\S/.test(line)) inPackages = false;
    }
  }
  return patterns;
}

function workspaceGlobScopeDirectories(index: OsnovaIndex): Set<string> {
  const directories = new Set<string>();
  for (const pattern of workspaceGlobPatterns(index)) {
    const trimmed = pattern.trim();
    if (trimmed === "" || trimmed.startsWith("!") || trimmed.includes("**")) continue;
    if (trimmed.endsWith("/*")) {
      const base = normalizeGlobBase(trimmed.slice(0, -2));
      for (const child of firstLevelChildDirectories(index, base)) directories.add(child);
    } else if (!trimmed.includes("*")) {
      const dir = normalizeGlobBase(trimmed);
      if (dir !== "" && directoryHasIndexedFile(index, dir)) directories.add(dir);
    }
  }
  return directories;
}

function scopeNameForDirectory(index: OsnovaIndex, dir: string): string {
  const manifest = index.files.get(`${dir}/package.json`);
  if (manifest !== undefined) {
    let json: unknown = null;
    try { json = JSON.parse(manifest.text); } catch { json = null; }
    if (json !== null && typeof json === "object" && "name" in json && typeof json.name === "string") return json.name;
  }
  return dir;
}

export function detectScopes(index: OsnovaIndex): PackageScope[] {
  const scopes = new Map<string, { path: string; name: string; manifests: { file: string; ecosystem: string; hash: string }[] }>();
  scopes.set("", { path: "", name: "repository", manifests: [] });
  for (const file of [...index.files.values()].sort((a, b) => compareText(a.path, b.path))) {
    const basename = file.path.split("/").pop() ?? "";
    const ecosystem = basename === "package.json" ? "node" : basename === "Cargo.toml" ? "cargo"
      : ["pyproject.toml", "setup.cfg", "setup.py"].includes(basename) ? "python"
        : basename === "go.mod" ? "go" : basename === "pom.xml" ? "maven" : basename.endsWith(".csproj") ? "dotnet" : null;
    if (ecosystem === null) continue;
    const path = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
    const scope = scopes.get(path) ?? { path, name: path || "repository", manifests: [] };
    scope.manifests.push({ file: file.path, ecosystem, hash: file.hash });
    if (basename === "package.json") {
      try {
        const json: unknown = JSON.parse(file.text);
        if (json !== null && typeof json === "object" && "name" in json && typeof json.name === "string") scope.name = json.name;
      } catch { scope.name = path || "repository"; }
    }
    scopes.set(path, scope);
  }
  for (const dir of workspaceGlobScopeDirectories(index)) {
    if (scopes.has(dir)) continue;
    scopes.set(dir, { path: dir, name: scopeNameForDirectory(index, dir), manifests: [] });
  }
  return [...scopes.values()].sort((a, b) => compareText(a.path, b.path));
}

function documentKey(file: string, qualifiedName: string | undefined): string {
  return qualifiedName === undefined ? `file:${file}` : `symbol:${qualifiedName}`;
}

function documentCovers(document: SearchDocument, term: string): boolean {
  return document.name.has(term) || document.signature.has(term) || document.documentation.has(term) ||
    document.path.has(term) || document.body.has(term);
}

function comparableScore(
  hit: ScopedAskHit,
  documents: ReadonlyMap<string, SearchDocument>,
  queryTokens: readonly string[],
  identifiers: ReadonlySet<string>,
  qualified: ReadonlySet<string>,
): number {
  const symbol = hit.symbol;
  const localName = symbol?.qualifiedName.split("#").slice(1).join("#").toLowerCase() ?? "";
  const priority = symbol !== null && localName.includes(".") && qualified.has(localName) ? 2
    : symbol !== null && identifiers.has(symbol.name.toLowerCase()) ? 1 : 0;
  const document = documents.get(documentKey(hit.file, symbol?.qualifiedName));
  const coversQuery = document === undefined || queryTokens.every((term) => documentCovers(document, term));
  return coversQuery ? hit.score - priority : 0;
}

export function isolatedIndex(index: OsnovaIndex, paths: ReadonlySet<string>): OsnovaIndex {
  const files = new Map([...index.files].filter(([path]) => paths.has(path)));
  const edges = index.edges.filter((edge) => {
    const target = edge.toSymbol === undefined ? edge.toFile : index.symbols.get(edge.toSymbol)?.file ?? edge.toFile;
    if (!paths.has(edge.fromFile) || target !== undefined && !paths.has(target)) return false;
    if (edge.evidence?.source === "syntax" && edge.evidence.resolution.status === "resolved") {
      const resolution = edge.evidence.resolution;
      if (resolution.via?.some((hop) => !paths.has(hop.file) || !paths.has(hop.targetFile))) return false;
      if (resolution.method === "receiver-hint") {
        const owner = index.symbols.get(resolution.receiver.classSymbol);
        if (owner === undefined || !paths.has(owner.file)) return false;
      }
    }
    return true;
  });
  return new OsnovaIndexImpl(index.root, files, edges);
}

export function scopedAsk(index: OsnovaIndex, question: string, options: AskOptions = {}): ScopedAskResult {
  const filter = normalizeScope(options.in);
  const limit = options.limit ?? 8;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("osnova: scoped limit must be a nonnegative safe integer");
  const receipt = indexReceipt(index);
  const scopes = detectScopes(index);
  const bySpecificity = [...scopes].sort((a, b) => b.path.length - a.path.length || compareText(a.path, b.path));
  const partitions = new Map<string, Set<string>>();
  for (const file of [...index.files.keys()].sort(compareText)) {
    if (!inScope(file, filter)) continue;
    const owner = bySpecificity.find((scope) => inScope(file, scope.path))!;
    const paths = partitions.get(owner.path) ?? new Set<string>();
    paths.add(file); partitions.set(owner.path, paths);
  }
  const selected = scopes.filter((scope) => partitions.has(scope.path));
  let filesSearched = 0;
  const ownerOf = new Map<string, string>();
  for (const scope of selected) {
    const paths = partitions.get(scope.path)!;
    filesSearched += paths.size;
    for (const file of paths) ownerOf.set(file, scope.path);
  }
  const detailed = askDetailed(index, question, { limit: Number.MAX_SAFE_INTEGER, full: options.full });
  const ctx = queryContext(index);
  const documents = new Map<string, SearchDocument>(
    ctx.documents.map((document) => [documentKey(document.file, document.symbol?.qualifiedName), document]),
  );
  const queryTokens = [...new Set(tokenize(question))];
  const identifiers = new Set((question.match(/[$A-Za-z_][$\w]*/g) ?? []).map((name) => name.toLowerCase()));
  const qualified = new Set((question.match(/[$A-Za-z_][$\w]*(?:\.[$A-Za-z_][$\w]*)+/g) ?? []).map((name) => name.toLowerCase()));
  const grouped = new Map<string, Array<{ hit: ScopedAskHit; order: number; comparable: number }>>(
    selected.map((scope) => [scope.path, []]),
  );
  let order = 0;
  for (const hit of detailed.hits) {
    const scopePath = ownerOf.get(hit.file);
    if (scopePath === undefined) continue;
    const scopedHit: ScopedAskHit = { ...hit, scope: scopePath, receipt: sourceReceipt(index, hit.file, receipt) };
    const comparable = comparableScore(scopedHit, documents, queryTokens, identifiers, qualified);
    grouped.get(scopePath)!.push({ hit: scopedHit, order, comparable });
    order += 1;
  }
  const perScope = selected.map((scope) => ({ scope, entries: grouped.get(scope.path)! }));
  const best = perScope.reduce((max, { entries }) => entries.length > 0
    ? Math.max(max, ...entries.map((entry) => entry.comparable)) : max, 0);
  const threshold = 0.25 * best;
  const topComparable = (entries: readonly { comparable: number }[]): number =>
    entries.reduce((max, entry) => Math.max(max, entry.comparable), 0);
  const participating = perScope.filter(({ entries }) => entries.length > 0 && topComparable(entries) >= threshold);
  const alsoMatched = perScope
    .filter(({ entries }) => entries.length > 0 && topComparable(entries) < threshold)
    .map(({ scope }) => scope)
    .sort((a, b) => compareText(a.path, b.path));
  const flattened = participating.flatMap(({ entries }) => entries);
  flattened.sort((a, b) => b.hit.score - a.hit.score || compareText(a.hit.scope, b.hit.scope) || a.order - b.order);
  const total = flattened.length;
  const hits = flattened.slice(0, limit).map((entry) => entry.hit);
  return { hits, filesSearched, scopes: selected, receipt, omittedHits: total - hits.length, alsoMatched,
    limitations: ["indexed-manifest-boundaries-only", "repository-wide-idf", "scope-participation-threshold-0.25", "indexed-content-not-disk-freshness"] };
}
