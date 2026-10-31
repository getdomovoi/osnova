import type { OsnovaIndex, OsnovaSymbol, SymbolKind, SymbolReach } from "../types.js";
import { compareText, indexReceipt, isReliableEdge, relationshipEvidence, sourceReceipt } from "./impact.js";
import type { DefinitionEvidence, IndexReceipt, RelationshipEvidence, SourceReceipt } from "./impact.js";
import { inScope, normalizeScope } from "./scoped.js";
import { askDetailed } from "./ask.js";
import { isTestFile } from "./tests.js";
import { reachCounter } from "./reach.js";

export class TaskContextBudgetError extends RangeError {
  constructor(readonly minimum: number) {
    super(`osnova: task context budget cannot retain receipts and omissions; minimum ${minimum} UTF-16 code units`);
  }
}

export interface TaskContextOptions {
  readonly task: "understand" | "change" | "review";
  readonly question: string;
  readonly symbols?: readonly string[] | undefined;
  readonly kinds?: readonly SymbolKind[] | undefined;
  readonly in?: string | undefined;
  readonly limit?: number | undefined;
  readonly maxDepth?: number | undefined;
  readonly maxCodeUnits?: number | undefined;
  readonly excerptLines?: number | undefined;
  readonly inlineShortDefinitions?: number | undefined;
  readonly measure?: ((result: TaskContextResult) => number) | undefined;
}

export interface ContextDefinition extends DefinitionEvidence {
  readonly excerpt: string;
  readonly reach?: SymbolReach | undefined;
}

export interface CandidateTest {
  readonly file: string;
  readonly symbol: OsnovaSymbol | null;
  readonly receipt: SourceReceipt;
  readonly path: readonly RelationshipEvidence[];
  readonly basis: "test-path-and-graph-relationship";
}

export interface RequestedSymbol {
  readonly name: string;
  /** returned: its definition is in the answer; omitted: found but cut by the budget; unknown: no indexed symbol has
   * this qualified name; out-of-scope: indexed outside the requested `in` scope. */
  readonly status: "returned" | "omitted" | "unknown" | "out-of-scope";
}

export interface TaskContextResult {
  readonly task: TaskContextOptions["task"];
  readonly scope: string;
  readonly receipt: IndexReceipt;
  readonly sources: readonly SourceReceipt[];
  readonly definitions: readonly ContextDefinition[];
  readonly relationships: readonly RelationshipEvidence[];
  readonly candidateTests: readonly CandidateTest[];
  readonly omitted: {
    readonly definitions: number;
    readonly relationships: number;
    readonly candidateTests: number;
    readonly retrievalHits: number;
    readonly uncertainEdges: number;
    readonly outOfScopeEdges: number;
    readonly depthFrontier: number;
    readonly unknownSymbols: number;
  };
  readonly limitations: readonly string[];
  /** Present only when the call named `symbols`: one entry per distinct requested name, sorted. */
  readonly requested?: readonly RequestedSymbol[] | undefined;
}

const seedOverfetch = 4;

const isTest = isTestFile;

interface EdgeMaps {
  readonly inbound: ReadonlyMap<string, readonly [number, RelationshipEvidence][]>;
  readonly outbound: ReadonlyMap<string, readonly [number, RelationshipEvidence][]>;
  readonly uncertain: number;
  readonly outside: number;
}

interface EdgeEntry {
  readonly reliable: readonly [number, RelationshipEvidence][];
  readonly uncertain: number;
  readonly scopes: Map<string, EdgeMaps>;
}

// Evidence for every edge costs about a second on a large index, so footing builds it once per index object and
// derives each scope's maps from it, sharing the evidence objects. A refresh publishes a new index object, which
// starts a new entry; within one index at most maxCachedScopes scopes are kept, the oldest dropped first.
const edgeMapCache = new WeakMap<OsnovaIndex, EdgeEntry>();
const maxCachedScopes = 8;

// Builds the unscoped edge maps ahead of the first footing call; the MCP server calls it while idle.
export function warmTaskContext(index: OsnovaIndex): void {
  edgeMaps(index, "", indexReceipt(index));
}

function edgeMaps(index: OsnovaIndex, scope: string, receipt: IndexReceipt): EdgeMaps {
  let entry = edgeMapCache.get(index);
  if (entry === undefined) {
    let uncertain = 0;
    const reliable: [number, RelationshipEvidence][] = [];
    index.edges.forEach((edge, key) => {
      const evidence = relationshipEvidence(index, edge, receipt);
      if (evidence === null || !isReliableEdge(edge)) { uncertain++; return; }
      reliable.push([key, evidence]);
    });
    entry = { reliable, uncertain, scopes: new Map() };
    edgeMapCache.set(index, entry);
  }
  const cached = entry.scopes.get(scope);
  if (cached !== undefined) return cached;
  let outside = 0;
  const inbound = new Map<string, [number, RelationshipEvidence][]>(), outbound = new Map<string, [number, RelationshipEvidence][]>();
  for (const item of entry.reliable) {
    const evidence = item[1];
    if (!inScope(evidence.source.file, scope) || !inScope(evidence.target.file, scope) ||
      evidence.viaSources.some((source) => !inScope(source.file, scope))) { outside++; continue; }
    const from = evidence.edge.fromSymbol || evidence.edge.fromFile;
    const to = evidence.edge.toSymbol ?? evidence.edge.toFile;
    if (to === undefined) continue;
    const ins = inbound.get(to) ?? []; ins.push(item); inbound.set(to, ins);
    const outs = outbound.get(from) ?? []; outs.push(item); outbound.set(from, outs);
  }
  const maps = { inbound, outbound, uncertain: entry.uncertain, outside };
  if (entry.scopes.size >= maxCachedScopes) entry.scopes.delete(entry.scopes.keys().next().value!);
  entry.scopes.set(scope, maps);
  return maps;
}

const isPreferredSeed = (symbol: OsnovaSymbol): boolean =>
  !isTest(symbol.file) && !(symbol.span.endLine === symbol.span.startLine && (symbol.kind === "constant" || symbol.kind === "type"));

export function taskContext(index: OsnovaIndex, options: TaskContextOptions): TaskContextResult {
  const maxCodeUnits = options.maxCodeUnits ?? 16_384;
  const maxDepth = options.maxDepth ?? 3;
  if (!Number.isSafeInteger(maxCodeUnits) || maxCodeUnits < 0) throw new RangeError("osnova: task context budget must be a nonnegative safe integer");
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) throw new RangeError("osnova: task context depth must be a nonnegative safe integer");
  const excerptLines = options.excerptLines;
  if (excerptLines !== undefined && (!Number.isSafeInteger(excerptLines) || excerptLines < 1)) throw new RangeError("osnova: task context excerpt lines must be a positive safe integer");
  if (!["understand", "change", "review"].includes(options.task)) throw new Error("osnova: invalid context task");
  const scope = normalizeScope(options.in);
  const receipt = indexReceipt(index);
  const seeds: OsnovaSymbol[] = [];
  let retrievalHits = 0, unknownSymbols = 0;
  const requested: { name: string; status: RequestedSymbol["status"] }[] = [];
  if (options.symbols !== undefined) {
    for (const name of [...new Set(options.symbols)].sort(compareText)) {
      const symbol = index.symbols.get(name);
      if (symbol === undefined || !inScope(symbol.file, scope)) {
        unknownSymbols++;
        requested.push({ name, status: symbol === undefined ? "unknown" : "out-of-scope" });
      } else {
        seeds.push(symbol);
        requested.push({ name, status: "returned" });
      }
    }
  } else {
    const limit = options.limit ?? 8;
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("osnova: task context limit must be a nonnegative safe integer");
    if (options.kinds !== undefined && options.kinds.length === 0) throw new RangeError("osnova: task context kinds must be a non-empty array of symbol kinds");
    const retrieved = askDetailed(index, options.question, { in: scope, limit: limit * seedOverfetch });
    const candidates = new Map<string, OsnovaSymbol>();
    for (const hit of retrieved.hits) {
      if (hit.symbol !== null && (options.kinds === undefined || options.kinds.includes(hit.symbol.kind))) candidates.set(hit.symbol.qualifiedName, hit.symbol);
    }
    const preferred = [...candidates.values()].filter(isPreferredSeed);
    const fallback = [...candidates.values()].filter((symbol) => !isPreferredSeed(symbol));
    for (const symbol of [...preferred, ...fallback]) if (seeds.length < limit) seeds.push(symbol);
    retrievalHits = retrieved.totalCandidates - seeds.length;
  }
  const sources = [...new Set(seeds.map((symbol) => symbol.file))].sort(compareText).map((file) => sourceReceipt(index, file, receipt));
  const definitions = new Map<string, ContextDefinition>();
  const reach = reachCounter(index);
  const addDefinition = (symbol: OsnovaSymbol, seed = false): void => {
    if (definitions.has(symbol.qualifiedName)) return;
    const lines = index.files.get(symbol.file)!.text.split("\n").slice(symbol.span.startLine - 1, symbol.span.endLine);
    const keepWhole = seed && options.inlineShortDefinitions !== undefined && lines.length <= options.inlineShortDefinitions;
    const excerpt = !keepWhole && excerptLines !== undefined && lines.length > excerptLines
      ? `${lines.slice(0, excerptLines).join("\n")}\n[+${lines.length - excerptLines} more lines]`
      : lines.join("\n");
    definitions.set(symbol.qualifiedName, { symbol, receipt: sourceReceipt(index, symbol.file, receipt), excerpt, ...(seed ? { reach: reach(symbol) } : {}) });
  };
  for (const seed of seeds) addDefinition(seed, true);
  const relationships = new Map<number, RelationshipEvidence>();
  const candidateTests = new Map<string, CandidateTest>();
  const frontier = new Set<string>();
  const { inbound, outbound, uncertain, outside } = edgeMaps(index, scope, receipt);
  for (const direction of options.task === "understand" ? ["out", "in"] as const : ["in", "out"] as const) {
    const seen = new Set(seeds.map((seed) => seed.qualifiedName));
    const queue = seeds.map((seed) => ({ node: seed.qualifiedName, path: [] as RelationshipEvidence[] }));
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const item = queue[cursor]!;
      for (const [key, evidence] of (direction === "in" ? inbound : outbound).get(item.node) ?? []) {
        const node = direction === "in" ? evidence.edge.fromSymbol || evidence.edge.fromFile : evidence.edge.toSymbol ?? evidence.edge.toFile!;
        if (item.path.length >= maxDepth) { if (!seen.has(node)) frontier.add(`${direction}:${node}`); continue; }
        relationships.set(key, evidence);
        const path = [...item.path, evidence];
        const symbol = index.symbols.get(node) ?? null;
        const file = direction === "in" ? evidence.source.file : evidence.target.file;
        if (symbol !== null) addDefinition(symbol);
        if (direction === "in" && isTest(file) && !candidateTests.has(file)) {
          candidateTests.set(file, { file, symbol, receipt: evidence.source, path, basis: "test-path-and-graph-relationship" });
        }
        if (seen.has(node)) continue;
        seen.add(node); queue.push({ node, path });
      }
    }
  }
  const result = {
    task: options.task, scope, receipt, sources,
    definitions: [] as ContextDefinition[], relationships: [] as RelationshipEvidence[], candidateTests: [] as CandidateTest[],
    omitted: { definitions: definitions.size, relationships: relationships.size, candidateTests: candidateTests.size,
      retrievalHits, uncertainEdges: uncertain, outOfScopeEdges: outside, depthFrontier: frontier.size, unknownSymbols },
    limitations: ["indexed-structural-evidence-only", "test-candidates-not-coverage", "receipts-not-disk-freshness", "uncertainty-counts-cover-entire-index",
      ...(receipt.diagnostics > 0 ? ["index-diagnostics-present"] : [])],
    ...(options.symbols !== undefined ? { requested } : {}),
  };
  const measure = options.measure ?? ((value: TaskContextResult): number => JSON.stringify(value).length);
  const size = (): number => measure(result);
  if (size() > maxCodeUnits) throw new TaskContextBudgetError(size());
  const append = <T>(items: Iterable<T>, target: T[], field: "definitions" | "relationships" | "candidateTests", limit = maxCodeUnits): T[] => {
    const left: T[] = [];
    for (const item of items) {
      target.push(item); result.omitted[field]--;
      if (size() > limit) { target.pop(); result.omitted[field]++; left.push(item); }
    }
    return left;
  };
  const seedNames = new Set(seeds.map((seed) => seed.qualifiedName));
  const seedDefinitions = [...definitions.values()].filter((definition) => seedNames.has(definition.symbol.qualifiedName));
  const relatedDefinitions = [...definitions.values()].filter((definition) => !seedNames.has(definition.symbol.qualifiedName));
  // Long seed excerpts could fill the whole budget and leave no relationships, which are what footing adds over
  // ground. With relationships to show, seeds after the first one placed take at most this share; any room left
  // returns to them last. Until one seed is placed each gets the whole budget, so a first seed too large to fit does
  // not push a later one that fits behind the relationships.
  const seedShare = relationships.size > 0 ? Math.floor(maxCodeUnits * 0.6) : maxCodeUnits;
  const deferredSeeds: ContextDefinition[] = [];
  for (const seed of seedDefinitions) {
    deferredSeeds.push(...append([seed], result.definitions, "definitions", result.definitions.length === 0 ? maxCodeUnits : seedShare));
  }
  const seedCount = result.definitions.length;
  if (options.task === "understand") {
    append(relationships.values(), result.relationships, "relationships");
    append(candidateTests.values(), result.candidateTests, "candidateTests");
  } else {
    // Change and review alternate callers and tests, so a symbol with many tests still shows the call sites an edit breaks.
    const related = [...relationships.values()];
    const tests = [...candidateTests.values()];
    for (let i = 0; i < Math.max(related.length, tests.length); i++) {
      if (i < related.length) append([related[i]!], result.relationships, "relationships");
      if (i < tests.length) append([tests[i]!], result.candidateTests, "candidateTests");
    }
  }
  append(deferredSeeds, result.definitions, "definitions");
  append(relatedDefinitions, result.definitions, "definitions");
  const settleStatuses = (): void => {
    const shown = new Set(result.definitions.map((definition) => definition.symbol.qualifiedName));
    for (const entry of requested) {
      if (entry.status === "returned" || entry.status === "omitted") entry.status = shown.has(entry.name) ? "returned" : "omitted";
    }
  };
  // Settling can move an omitted name ahead in the capped requested line, so the text can grow after it was
  // measured; drop the latest-added items until it fits again: related definitions and deferred seeds first, then
  // candidate tests and relationships, and the seeds placed in the first pass last.
  settleStatuses();
  while (size() > maxCodeUnits) {
    if (result.definitions.length > seedCount) { result.definitions.pop(); result.omitted.definitions++; }
    else if (result.candidateTests.length > 0) { result.candidateTests.pop(); result.omitted.candidateTests++; }
    else if (result.relationships.length > 0) { result.relationships.pop(); result.omitted.relationships++; }
    else if (result.definitions.length > 0) { result.definitions.pop(); result.omitted.definitions++; }
    else throw new TaskContextBudgetError(size());
    settleStatuses();
  }
  return result;
}
