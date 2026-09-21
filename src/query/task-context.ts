import type { OsnovaIndex, OsnovaSymbol, SymbolKind, SymbolReach } from "../types.js";
import { compareText, indexReceipt, isReliableEdge, relationshipEvidence, sourceReceipt } from "./impact.js";
import type { DefinitionEvidence, IndexReceipt, RelationshipEvidence, SourceReceipt } from "./impact.js";
import { inScope, normalizeScope } from "./scoped.js";
import { askDetailed } from "./ask.js";
import { isTestFile } from "./tests.js";
import { reachCounter } from "./reach.js";

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
}

const seedOverfetch = 4;

const isTest = isTestFile;

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
  if (options.symbols !== undefined) {
    for (const name of [...new Set(options.symbols)].sort(compareText)) {
      const symbol = index.symbols.get(name);
      if (symbol === undefined || !inScope(symbol.file, scope)) unknownSymbols++;
      else seeds.push(symbol);
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
  let uncertain = 0, outside = 0;
  const sortedEdges: [number, RelationshipEvidence][] = [];
  index.edges.forEach((edge, key) => {
    const evidence = relationshipEvidence(index, edge, receipt);
    if (evidence === null || !isReliableEdge(edge)) { uncertain++; return; }
    if (!inScope(evidence.source.file, scope) || !inScope(evidence.target.file, scope) ||
      evidence.viaSources.some((source) => !inScope(source.file, scope))) { outside++; return; }
    sortedEdges.push([key, evidence]);
  });
  const inbound = new Map<string, [number, RelationshipEvidence][]>(), outbound = new Map<string, [number, RelationshipEvidence][]>();
  for (const [key, evidence] of sortedEdges) {
    const from = evidence.edge.fromSymbol || evidence.edge.fromFile;
    const to = evidence.edge.toSymbol ?? evidence.edge.toFile;
    if (to === undefined) continue;
    const ins = inbound.get(to) ?? []; ins.push([key, evidence]); inbound.set(to, ins);
    const outs = outbound.get(from) ?? []; outs.push([key, evidence]); outbound.set(from, outs);
  }
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
  };
  const measure = options.measure ?? ((value: TaskContextResult): number => JSON.stringify(value).length);
  const size = (): number => measure(result);
  if (size() > maxCodeUnits) throw new RangeError(`osnova: task context budget cannot retain receipts and omissions; minimum ${size()} UTF-16 code units`);
  const append = <T>(items: Iterable<T>, target: T[], field: "definitions" | "relationships" | "candidateTests"): void => {
    for (const item of items) {
      target.push(item); result.omitted[field]--;
      if (size() > maxCodeUnits) { target.pop(); result.omitted[field]++; }
    }
  };
  const seedNames = new Set(seeds.map((seed) => seed.qualifiedName));
  const seedDefinitions = [...definitions.values()].filter((definition) => seedNames.has(definition.symbol.qualifiedName));
  const relatedDefinitions = [...definitions.values()].filter((definition) => !seedNames.has(definition.symbol.qualifiedName));
  append(seedDefinitions, result.definitions, "definitions");
  if (options.task !== "understand") append(candidateTests.values(), result.candidateTests, "candidateTests");
  append(relationships.values(), result.relationships, "relationships");
  if (options.task === "understand") append(candidateTests.values(), result.candidateTests, "candidateTests");
  append(relatedDefinitions, result.definitions, "definitions");
  return result;
}
