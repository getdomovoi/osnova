import { OsnovaIndexImpl } from "../index/indexImpl.js";
import type { AskHit, AskOptions, OsnovaIndex } from "../types.js";
import { ask } from "./ask.js";
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
  return [...scopes.values()].sort((a, b) => compareText(a.path, b.path));
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
  const queues = selected.map((scope) => {
    const paths = partitions.get(scope.path)!;
    filesSearched += paths.size;
    const result = ask(isolatedIndex(index, paths), question, { limit: Number.MAX_SAFE_INTEGER, full: options.full, graphRank: options.graphRank });
    return result.hits.map((hit) => ({ ...hit, scope: scope.path, receipt: sourceReceipt(index, hit.file, receipt) }));
  });
  const hits: ScopedAskHit[] = [];
  const total = queues.reduce((sum, queue) => sum + queue.length, 0);
  for (let round = 0; hits.length < Math.min(limit, total); round++) {
    for (const queue of queues) {
      const hit = queue[round];
      if (hit !== undefined && hits.length < limit) hits.push(hit);
    }
  }
  return { hits, filesSearched, scopes: selected, receipt, omittedHits: total - hits.length,
    limitations: ["indexed-manifest-boundaries-only", "package-scores-are-local", "scope-round-robin-path-order", "indexed-content-not-disk-freshness"] };
}
