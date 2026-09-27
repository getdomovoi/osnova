import type { OsnovaIndex, OsnovaSymbol, SymbolKind } from "../types.js";
import { languageFamily } from "../index/resolve.js";
import { compareText, indexReceipt, sourceReceipt } from "./impact.js";
import type { IndexReceipt, SourceReceipt } from "./impact.js";
import { isTestFile } from "./tests.js";

export type EntryPointRule = "main" | "default-export" | "index-file" | "package-bin" | "test-file" | "constructor" | "python-dunder";

export interface UnreferencedCandidate {
  readonly symbol: OsnovaSymbol;
  readonly receipt: SourceReceipt;
  readonly exported: boolean;
  readonly unresolvedSameNameSites: number;
  readonly testSites: number;
  readonly mentions: number | null;
}

export interface UnreferencedOptions {
  readonly scope?: string | undefined;
  readonly kinds?: readonly SymbolKind[] | undefined;
  readonly limit?: number | undefined;
  readonly includeExported?: boolean | undefined;
}

export interface UnreferencedResult {
  readonly receipt: IndexReceipt;
  readonly scope: string;
  readonly kinds: readonly SymbolKind[];
  readonly examined: number;
  readonly candidates: readonly UnreferencedCandidate[];
  readonly omitted: number;
  readonly withoutLeads: number;
  readonly exportedNotListed: number;
  readonly shadowedNotListed: number;
  readonly entryPoints: Readonly<Record<EntryPointRule, number>>;
  readonly mentionsScanned: boolean;
  readonly limitations: readonly string[];
}

const defaultLimit = 50;
export const defaultUnreferencedKinds: readonly SymbolKind[] = ["function", "method", "class"];
const maximumMentionCorpusCodeUnits = 32 * 1024 * 1024;
const symbolKinds: readonly SymbolKind[] = ["function", "method", "class", "struct", "interface", "trait", "enum", "type", "constant", "module"];

export const unreferencedLimitations = [
  "resolved-call-reference-and-extends-edges-only",
  "default-kinds-function-method-class-because-other-kinds-receive-no-edges",
  "no-indexed-caller-is-not-proof-of-no-caller",
  "export-detection-typescript-javascript-python-only",
  "no-decorator-or-framework-hook-metadata",
  "text-mentions-are-identifier-tokens-not-references",
  "shadowed-declarations-never-listed",
] as const;

export const unreferencedNotice = "Candidates only: no indexed caller is not proof of no caller. Dynamic calls, reflection, string references and external consumers are not indexed.";

export const entryPointRuleText = "entry points never listed: symbols named main, default exports, files named index.*, files named by package.json bin, test files, constructors (instantiation edges target the class) and Python dunders such as __getattr__ or __repr__ (the runtime calls them without a call site); the index records no decorator or framework-hook metadata, so decorated definitions are not excluded.";

function normalizeScope(scope: string | undefined): string {
  let text = (scope ?? "").replace(/\\/g, "/").trim();
  while (text.startsWith("./")) text = text.slice(2);
  while (text.endsWith("/")) text = text.slice(0, -1);
  if (text === ".") return "";
  return text;
}

function inScope(file: string, scope: string): boolean {
  return file.startsWith(scope);
}

function isExported(index: OsnovaIndex, symbol: OsnovaSymbol): boolean {
  if ((symbol.exportedNames?.length ?? 0) > 0) return true;
  const separator = symbol.qualifiedName.lastIndexOf(".");
  const hash = symbol.qualifiedName.indexOf("#");
  if (separator <= hash) return false;
  const parent = index.symbols.get(symbol.qualifiedName.slice(0, separator));
  return parent !== undefined && isExported(index, parent);
}

function packageBinFiles(index: OsnovaIndex): Set<string> {
  const files = new Set<string>();
  const text = index.files.get("package.json")?.text;
  if (text === undefined) return files;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return files;
  }
  const bin = typeof parsed === "object" && parsed !== null ? (parsed as { bin?: unknown }).bin : undefined;
  const entries = typeof bin === "string" ? [bin] : typeof bin === "object" && bin !== null ? Object.values(bin).filter((v): v is string => typeof v === "string") : [];
  for (const entry of entries) files.add(normalizeScope(entry));
  return files;
}

function isNested(fromSymbol: string, target: string): boolean {
  return fromSymbol === target || fromSymbol.startsWith(`${target}.`);
}

function entryPointRule(index: OsnovaIndex, symbol: OsnovaSymbol, binFiles: ReadonlySet<string>): EntryPointRule | null {
  if (isTestFile(symbol.file)) return "test-file";
  if (binFiles.has(symbol.file)) return "package-bin";
  if (/(?:^|\/)index\.[^/]+$/.test(symbol.file)) return "index-file";
  if (symbol.exportedNames?.includes("default")) return "default-export";
  if (symbol.name === "main") return "main";
  if (symbol.kind === "method" && (symbol.name === "constructor" || symbol.name === "__init__")) return "constructor";
  if (/^__\w+__$/.test(symbol.name) && index.files.get(symbol.file)?.language === "python") return "python-dunder";
  return null;
}

interface MentionTarget { readonly qualifiedName: string; readonly file: string; readonly start: number; readonly end: number }

function countMentions(index: OsnovaIndex, candidates: readonly OsnovaSymbol[]): Map<string, number> | null {
  const counts = new Map<string, number>();
  let total = 0;
  for (const card of index.files.values()) {
    if (isTestFile(card.path)) continue;
    total += card.text.length;
    if (total > maximumMentionCorpusCodeUnits) return null;
  }
  const byName = new Map<string, MentionTarget[]>();
  for (const symbol of candidates) {
    counts.set(symbol.qualifiedName, 0);
    const list = byName.get(symbol.name) ?? [];
    list.push({ qualifiedName: symbol.qualifiedName, file: symbol.file, start: symbol.span.startLine, end: symbol.span.endLine });
    byName.set(symbol.name, list);
  }
  if (counts.size === 0) return counts;
  const identifier = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  for (const card of index.files.values()) {
    if (isTestFile(card.path)) continue;
    const lines = card.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = i + 1;
      for (const match of lines[i]!.matchAll(identifier)) {
        for (const target of byName.get(match[0]) ?? []) {
          if (target.file === card.path && line >= target.start && line <= target.end) continue;
          counts.set(target.qualifiedName, counts.get(target.qualifiedName)! + 1);
        }
      }
    }
  }
  return counts;
}

export function unreferenced(index: OsnovaIndex, options: UnreferencedOptions = {}): UnreferencedResult {
  const limit = options.limit ?? defaultLimit;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("osnova: unreferenced limit must be a nonnegative safe integer");
  for (const kind of options.kinds ?? []) {
    if (!symbolKinds.includes(kind)) throw new Error(`osnova: kinds must be symbol kinds (${symbolKinds.join(", ")}), got ${JSON.stringify(kind)}`);
  }
  const kindList = [...new Set(options.kinds ?? defaultUnreferencedKinds)].sort(compareText);
  const kinds = new Set(kindList);
  const scope = normalizeScope(options.scope);
  const receipt = indexReceipt(index);
  const binFiles = packageBinFiles(index);
  const referenced = new Set<string>();
  const testReferences = new Map<string, number>();
  const unresolvedByName = new Map<string, number>();
  for (const edge of index.edges) {
    if (edge.kind === "imports") continue;
    if (edge.toSymbol === undefined) {
      const name = edge.toName.split(".").pop() ?? edge.toName;
      const key = `${languageFamily(index.files.get(edge.fromFile)?.language) ?? ""}\u0000${name}`;
      unresolvedByName.set(key, (unresolvedByName.get(key) ?? 0) + 1);
      continue;
    }
    if (isNested(edge.fromSymbol, edge.toSymbol)) continue;
    if (isTestFile(edge.fromFile)) testReferences.set(edge.toSymbol, (testReferences.get(edge.toSymbol) ?? 0) + 1);
    else referenced.add(edge.toSymbol);
  }
  const entryPoints: Record<EntryPointRule, number> = { main: 0, "default-export": 0, "index-file": 0, "package-bin": 0, "test-file": 0, constructor: 0, "python-dunder": 0 };
  let examined = 0;
  let exportedNotListed = 0;
  let shadowedNotListed = 0;
  const found: OsnovaSymbol[] = [];
  for (const symbol of index.symbols.values()) {
    if (!inScope(symbol.file, scope) || !kinds.has(symbol.kind)) continue;
    examined++;
    if (referenced.has(symbol.qualifiedName)) continue;
    // A name the file declares in more than one scope can receive no edge at all, so its absence from
    // the graph says nothing about its use.
    if (symbol.shadowed === true) { shadowedNotListed++; continue; }
    const rule = entryPointRule(index, symbol, binFiles);
    if (rule !== null) { entryPoints[rule]++; continue; }
    const exported = isExported(index, symbol);
    if (exported && options.includeExported !== true) { exportedNotListed++; continue; }
    found.push(symbol);
  }
  found.sort((a, b) => compareText(a.file, b.file) || a.span.startLine - b.span.startLine || compareText(a.qualifiedName, b.qualifiedName));
  const kept = found.slice(0, limit);
  const mentions = countMentions(index, kept);
  const candidates = kept.map((symbol): UnreferencedCandidate => {
    const family = languageFamily(index.files.get(symbol.file)?.language) ?? "";
    return {
      symbol,
      receipt: sourceReceipt(index, symbol.file, receipt),
      exported: isExported(index, symbol),
      unresolvedSameNameSites: (unresolvedByName.get(`${family}\u0000${symbol.name}`) ?? 0) + (family === "" ? 0 : unresolvedByName.get(`\u0000${symbol.name}`) ?? 0),
      testSites: testReferences.get(symbol.qualifiedName) ?? 0,
      mentions: mentions === null ? null : mentions.get(symbol.qualifiedName) ?? 0,
    };
  });
  const withoutLeads = candidates.filter((candidate) => candidate.unresolvedSameNameSites === 0 && candidate.testSites === 0 && candidate.mentions === 0).length;
  return {
    receipt, scope, kinds: kindList, examined, candidates, omitted: found.length - kept.length, withoutLeads, exportedNotListed, shadowedNotListed, entryPoints,
    mentionsScanned: mentions !== null, limitations: [...unreferencedLimitations],
  };
}
