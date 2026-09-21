import type { EdgeKind, OsnovaEdge, OsnovaIndex, OsnovaSymbol } from "../types.js";
import { compareText, indexReceipt, isReliableEdge, sourceReceipt } from "./impact.js";
import type { IndexReceipt, SourceReceipt } from "./impact.js";

export const isTestFile = (file: string): boolean => /(?:^|\/)(?:tests?|__tests__)\//.test(file) ||
  /(?:^|\/)test_[^/]+\.py$/.test(file) || /(?:\.(?:test|spec)\.[^/]+|_test\.(?:go|py))$/.test(file);

export interface TestSite {
  readonly line: number;
  readonly kind: EdgeKind;
  readonly method: string;
  readonly fromSymbol: string | null;
}

export interface TestFileEvidence {
  readonly file: string;
  readonly receipt: SourceReceipt;
  readonly basis: "test-path-and-resolved-edge" | "test-path-and-file-import";
  readonly sites: readonly TestSite[];
  readonly omittedSites: number;
}

export interface SymbolTests {
  readonly symbol: OsnovaSymbol;
  readonly receipt: SourceReceipt;
  readonly tests: readonly TestFileEvidence[];
  readonly omittedTests: number;
}

export interface TestsForOptions {
  readonly limit?: number | undefined;
  readonly sitesPerFile?: number | undefined;
}

export interface TestsForResult {
  readonly receipt: IndexReceipt;
  readonly symbols: readonly SymbolTests[];
  readonly unknownSymbols: readonly string[];
  readonly limitations: readonly string[];
}

export interface SymbolUnderTest {
  readonly symbol: OsnovaSymbol;
  readonly receipt: SourceReceipt;
  readonly sites: readonly TestSite[];
  readonly omittedSites: number;
}

export interface ImportUnderTest {
  readonly file: string;
  readonly receipt: SourceReceipt;
  readonly lines: readonly number[];
}

export interface SymbolsUnderTestOptions {
  readonly limit?: number | undefined;
  readonly sitesPerSymbol?: number | undefined;
}

export interface SymbolsUnderTestResult {
  readonly receipt: IndexReceipt;
  readonly file: string;
  readonly fileReceipt: SourceReceipt;
  readonly isTestPath: boolean;
  readonly symbols: readonly SymbolUnderTest[];
  readonly omittedSymbols: number;
  readonly imports: readonly ImportUnderTest[];
  readonly unresolvedEdges: number;
  readonly limitations: readonly string[];
}

const defaultTestFiles = 20;
const defaultSymbols = 50;
const defaultSites = 10;

export const testsLimitations = ["test-path-pattern-plus-indexed-edge", "direct-edges-only", "not-coverage", "no-indexed-test-is-not-proof-of-no-test"] as const;

const compareSites = (a: TestSite, b: TestSite): number => a.line - b.line || compareText(a.kind, b.kind) || compareText(a.fromSymbol ?? "", b.fromSymbol ?? "");

function checkLimit(value: number | undefined, label: string): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new RangeError(`osnova: tests ${label} must be a nonnegative safe integer`);
  return value;
}

function edgeMethod(edge: OsnovaEdge): string {
  const evidence = edge.evidence;
  return evidence?.source === "syntax" ? evidence.resolution.status === "resolved" ? evidence.resolution.method : evidence.resolution.status : "unknown-provenance";
}

function site(edge: OsnovaEdge): TestSite {
  return { line: edge.line, kind: edge.kind, method: edgeMethod(edge), fromSymbol: edge.fromSymbol.length > 0 ? edge.fromSymbol : null };
}

function resolveSymbols(index: OsnovaIndex, name: string): OsnovaSymbol[] {
  const exact = index.symbols.get(name);
  if (exact !== undefined) return [exact];
  if (name.includes("#")) return [];
  const matches: OsnovaSymbol[] = [];
  for (const symbol of index.symbols.values()) {
    if (symbol.name === name || (name.includes(".") && symbol.qualifiedName.endsWith(`#${name}`))) matches.push(symbol);
  }
  return matches.sort((a, b) => compareText(a.qualifiedName, b.qualifiedName));
}

function clip<T>(items: readonly T[], limit: number): { kept: T[]; omitted: number } {
  return { kept: items.slice(0, limit), omitted: Math.max(0, items.length - limit) };
}

export const isIndexedTestEdge = (index: OsnovaIndex, edge: OsnovaEdge): boolean =>
  isTestFile(edge.fromFile) && isReliableEdge(edge) && index.files.has(edge.fromFile);

export function collectTestImports(index: OsnovaIndex): Map<string, Map<string, number[]>> {
  const importsByFile = new Map<string, Map<string, number[]>>();
  for (const edge of index.edges) {
    if (edge.kind !== "imports" || edge.toFile === undefined || !isIndexedTestEdge(index, edge)) continue;
    const byTest = importsByFile.get(edge.toFile) ?? new Map<string, number[]>();
    const lines = byTest.get(edge.fromFile) ?? [];
    lines.push(edge.line);
    byTest.set(edge.fromFile, lines);
    importsByFile.set(edge.toFile, byTest);
  }
  return importsByFile;
}

export function testsFor(index: OsnovaIndex, symbols: readonly string[], options: TestsForOptions = {}): TestsForResult {
  if (symbols.length === 0) throw new Error("osnova: tests needs at least one symbol name");
  const limit = checkLimit(options.limit, "limit") ?? defaultTestFiles;
  const sitesPerFile = checkLimit(options.sitesPerFile, "sites per file") ?? defaultSites;
  const receipt = indexReceipt(index);
  const targets = new Map<string, OsnovaSymbol>();
  const unknown: string[] = [];
  for (const name of [...new Set(symbols)].sort(compareText)) {
    const found = resolveSymbols(index, name);
    if (found.length === 0) unknown.push(name);
    for (const symbol of found) targets.set(symbol.qualifiedName, symbol);
  }
  const importsByFile = collectTestImports(index);
  const result: SymbolTests[] = [];
  for (const symbol of [...targets.values()].sort((a, b) => compareText(a.qualifiedName, b.qualifiedName))) {
    const byTest = new Map<string, TestSite[]>();
    for (const edge of index.incoming(symbol.qualifiedName)) {
      if (!isIndexedTestEdge(index, edge)) continue;
      const sites = byTest.get(edge.fromFile) ?? [];
      sites.push(site(edge));
      byTest.set(edge.fromFile, sites);
    }
    const files: TestFileEvidence[] = [];
    for (const [file, sites] of byTest) {
      const { kept, omitted } = clip(sites.sort(compareSites), sitesPerFile);
      files.push({ file, receipt: sourceReceipt(index, file, receipt), basis: "test-path-and-resolved-edge", sites: kept, omittedSites: omitted });
    }
    for (const [file, lines] of importsByFile.get(symbol.file) ?? []) {
      if (byTest.has(file)) continue;
      const sites = lines.sort((a, b) => a - b).map((line): TestSite => ({ line, kind: "imports", method: "import-path", fromSymbol: null }));
      const { kept, omitted } = clip(sites, sitesPerFile);
      files.push({ file, receipt: sourceReceipt(index, file, receipt), basis: "test-path-and-file-import", sites: kept, omittedSites: omitted });
    }
    files.sort((a, b) => Number(a.basis === "test-path-and-file-import") - Number(b.basis === "test-path-and-file-import") || compareText(a.file, b.file));
    const { kept, omitted } = clip(files, limit);
    result.push({ symbol, receipt: sourceReceipt(index, symbol.file, receipt), tests: kept, omittedTests: omitted });
  }
  return { receipt, symbols: result, unknownSymbols: unknown, limitations: [...testsLimitations] };
}

export function symbolsUnderTest(index: OsnovaIndex, testFile: string, options: SymbolsUnderTestOptions = {}): SymbolsUnderTestResult {
  const limit = checkLimit(options.limit, "limit") ?? defaultSymbols;
  const sitesPerSymbol = checkLimit(options.sitesPerSymbol, "sites per symbol") ?? defaultSites;
  if (!index.files.has(testFile)) throw new Error(`osnova: file not indexed: ${testFile}`);
  const receipt = indexReceipt(index);
  const bySymbol = new Map<string, TestSite[]>();
  const importLines = new Map<string, number[]>();
  let unresolved = 0;
  for (const edge of index.edgesForFile(testFile)) {
    if (edge.fromFile !== testFile) continue;
    if (edge.kind === "imports") {
      if (edge.toFile === undefined || !isReliableEdge(edge)) { unresolved++; continue; }
      if (isTestFile(edge.toFile) || !index.files.has(edge.toFile)) continue;
      const lines = importLines.get(edge.toFile) ?? [];
      lines.push(edge.line);
      importLines.set(edge.toFile, lines);
      continue;
    }
    if (edge.toSymbol === undefined || !isReliableEdge(edge)) { unresolved++; continue; }
    const target = index.symbols.get(edge.toSymbol);
    if (target === undefined || isTestFile(target.file)) continue;
    const sites = bySymbol.get(target.qualifiedName) ?? [];
    sites.push(site(edge));
    bySymbol.set(target.qualifiedName, sites);
  }
  const symbols: SymbolUnderTest[] = [];
  for (const [name, sites] of bySymbol) {
    const symbol = index.symbols.get(name)!;
    const { kept, omitted } = clip(sites.sort(compareSites), sitesPerSymbol);
    symbols.push({ symbol, receipt: sourceReceipt(index, symbol.file, receipt), sites: kept, omittedSites: omitted });
  }
  symbols.sort((a, b) => compareText(a.symbol.qualifiedName, b.symbol.qualifiedName));
  const { kept, omitted } = clip(symbols, limit);
  const imports = [...importLines].map(([file, lines]): ImportUnderTest => ({ file, receipt: sourceReceipt(index, file, receipt), lines: lines.sort((a, b) => a - b) }))
    .sort((a, b) => compareText(a.file, b.file));
  return {
    receipt, file: testFile, fileReceipt: sourceReceipt(index, testFile, receipt), isTestPath: isTestFile(testFile),
    symbols: kept, omittedSymbols: omitted, imports, unresolvedEdges: unresolved, limitations: [...testsLimitations],
  };
}
