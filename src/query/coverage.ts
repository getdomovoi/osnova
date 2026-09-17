import type { OsnovaIndex } from "../types.js";
import { indexGeneration } from "../api.js";
import { compareText } from "./impact.js";

export interface LanguageCoverage {
  readonly language: string;
  readonly files: number;
  readonly symbols: number;
  readonly calls: number;
  readonly resolved: number;
  readonly ambiguous: number;
  readonly unresolved: number;
  readonly imports: number;
  readonly importsResolved: number;
  readonly byMethod: Readonly<Record<string, number>>;
  readonly byReason: Readonly<Record<string, number>>;
  readonly resolvedShare: number;
  readonly unresolvedImportCalls: number;
  readonly unboundGlobalCalls: number;
  readonly resolvedShareExcludingUnresolvedImports: number;
  readonly resolvedShareExcludingExternal: number;
}

export interface CoverageReport {
  readonly generation: string;
  readonly languages: readonly LanguageCoverage[];
  readonly total: LanguageCoverage;
  readonly limitations: readonly string[];
}

interface Tally {
  files: number; symbols: number; calls: number; resolved: number; ambiguous: number; unresolved: number; imports: number; importsResolved: number;
  byMethod: Map<string, number>; byReason: Map<string, number>;
}

const tally = (): Tally => ({ files: 0, symbols: 0, calls: 0, resolved: 0, ambiguous: 0, unresolved: 0, imports: 0, importsResolved: 0, byMethod: new Map(), byReason: new Map() });
const bump = (map: Map<string, number>, key: string): void => { map.set(key, (map.get(key) ?? 0) + 1); };
const sortedRecord = (map: Map<string, number>): Record<string, number> =>
  Object.fromEntries([...map].sort(([a], [b]) => compareText(a, b)));
const share = (resolved: number, calls: number): number => calls === 0 ? 0 : Math.round((resolved / calls) * 10000) / 10000;
const finish = (language: string, t: Tally): LanguageCoverage => {
  const unresolvedImportCalls = t.byReason.get("import-target-unresolved") ?? 0;
  const unboundGlobalCalls = t.byReason.get("unbound-global") ?? 0;
  return {
    language, files: t.files, symbols: t.symbols, calls: t.calls, resolved: t.resolved, ambiguous: t.ambiguous, unresolved: t.unresolved,
    imports: t.imports, importsResolved: t.importsResolved, byMethod: sortedRecord(t.byMethod), byReason: sortedRecord(t.byReason), resolvedShare: share(t.resolved, t.calls),
    unresolvedImportCalls, unboundGlobalCalls, resolvedShareExcludingUnresolvedImports: share(t.resolved, t.calls - unresolvedImportCalls),
    resolvedShareExcludingExternal: share(t.resolved, t.calls - unresolvedImportCalls - unboundGlobalCalls),
  };
};

export function resolutionCoverage(index: OsnovaIndex): CoverageReport {
  const perLanguage = new Map<string, Tally>();
  const total = tally();
  const rowFor = (language: string): Tally => { let row = perLanguage.get(language); if (row === undefined) { row = tally(); perLanguage.set(language, row); } return row; };
  for (const card of index.files.values()) {
    const row = rowFor(card.language);
    row.files++; total.files++;
    row.symbols += card.symbols.length; total.symbols += card.symbols.length;
  }
  for (const edge of index.edges) {
    const language = index.files.get(edge.fromFile)?.language ?? "unknown";
    const rows = [rowFor(language), total];
    const resolution = edge.evidence?.source === "syntax" ? edge.evidence.resolution : undefined;
    if (edge.kind === "imports") {
      for (const row of rows) { row.imports++; if (resolution?.status === "resolved") row.importsResolved++; }
      continue;
    }
    if (edge.kind !== "calls") continue;
    for (const row of rows) {
      row.calls++;
      if (resolution === undefined) { row.unresolved++; bump(row.byReason, "unknown-provenance"); }
      else if (resolution.status === "resolved") { row.resolved++; bump(row.byMethod, resolution.method); }
      else if (resolution.status === "ambiguous") row.ambiguous++;
      else { row.unresolved++; bump(row.byReason, resolution.reason); }
    }
  }
  const languages = [...perLanguage].sort(([a], [b]) => compareText(a, b)).map(([language, row]) => finish(language, row));
  return {
    generation: indexGeneration(index), languages, total: finish("all", total),
    limitations: ["indexed-call-sites-only", "resolution-is-heuristic-not-type-inference", "unindexed-files-not-counted", "unresolved-import-calls-are-import-target-unresolved-edges", "unbound-global-calls-are-names-with-no-binding-in-the-file"],
  };
}
