import { maximumIndexedFileSizeBytes } from "../types.js";
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
  readonly references: number;
  readonly referencesResolved: number;
  readonly extends: number;
  readonly extendsResolved: number;
  readonly routes: number;
  readonly routesResolved: number;
  readonly byMethod: Readonly<Record<string, number>>;
  readonly byReason: Readonly<Record<string, number>>;
  readonly resolvedShare: number;
  readonly unresolvedImportCalls: number;
  readonly unboundGlobalCalls: number;
  readonly resolvedShareExcludingUnresolvedImports: number;
  readonly resolvedShareExcludingExternal: number;
  readonly externalImportCalls: number;
  readonly byExternal: Readonly<Record<string, number>>;
}

export interface OversizedFileCoverage {
  readonly path: string;
  readonly size: number;
  readonly limitBytes: number;
}

export interface CoverageReport {
  readonly generation: string;
  readonly languages: readonly LanguageCoverage[];
  readonly total: LanguageCoverage;
  readonly diagnostics: Readonly<Record<string, number>>;
  readonly oversizedFiles: readonly OversizedFileCoverage[];
  readonly limitations: readonly string[];
}

interface Tally {
  files: number; symbols: number; calls: number; resolved: number; ambiguous: number; unresolved: number; imports: number; importsResolved: number;
  references: number; referencesResolved: number; extends: number; extendsResolved: number; routes: number; routesResolved: number;
  byMethod: Map<string, number>; byReason: Map<string, number>; byExternal: Map<string, number>;
}

const tally = (): Tally => ({ files: 0, symbols: 0, calls: 0, resolved: 0, ambiguous: 0, unresolved: 0, imports: 0, importsResolved: 0, references: 0, referencesResolved: 0, extends: 0, extendsResolved: 0, routes: 0, routesResolved: 0, byMethod: new Map(), byReason: new Map(), byExternal: new Map() });
const bump = (map: Map<string, number>, key: string): void => { map.set(key, (map.get(key) ?? 0) + 1); };
const sortedRecord = (map: Map<string, number>): Record<string, number> =>
  Object.fromEntries([...map].sort(([a], [b]) => compareText(a, b)));
const share = (resolved: number, calls: number): number => calls === 0 ? 0 : Math.round((resolved / calls) * 10000) / 10000;
const finish = (language: string, t: Tally): LanguageCoverage => {
  const unresolvedImportCalls = t.byReason.get("import-target-unresolved") ?? 0;
  const unboundGlobalCalls = t.byReason.get("unbound-global") ?? 0;
  return {
    language, files: t.files, symbols: t.symbols, calls: t.calls, resolved: t.resolved, ambiguous: t.ambiguous, unresolved: t.unresolved,
    imports: t.imports, importsResolved: t.importsResolved, references: t.references, referencesResolved: t.referencesResolved, extends: t.extends, extendsResolved: t.extendsResolved, routes: t.routes, routesResolved: t.routesResolved, byMethod: sortedRecord(t.byMethod), byReason: sortedRecord(t.byReason), resolvedShare: share(t.resolved, t.calls),
    unresolvedImportCalls, unboundGlobalCalls, resolvedShareExcludingUnresolvedImports: share(t.resolved, t.calls - unresolvedImportCalls),
    resolvedShareExcludingExternal: share(t.resolved, t.calls - unresolvedImportCalls - unboundGlobalCalls),
    externalImportCalls: [...t.byExternal.values()].reduce((sum, count) => sum + count, 0), byExternal: sortedRecord(t.byExternal),
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
    if (edge.kind === "references") {
      for (const row of rows) { row.references++; if (resolution?.status === "resolved") row.referencesResolved++; }
      continue;
    }
    if (edge.kind === "extends") {
      for (const row of rows) { row.extends++; if (resolution?.status === "resolved") row.extendsResolved++; }
      continue;
    }
    if (edge.kind === "routes") {
      for (const row of rows) { row.routes++; if (resolution?.status === "resolved") row.routesResolved++; }
      continue;
    }
    if (edge.kind !== "calls") continue;
    for (const row of rows) {
      row.calls++;
      if (resolution === undefined) { row.unresolved++; bump(row.byReason, "unknown-provenance"); }
      else if (resolution.status === "resolved") { row.resolved++; bump(row.byMethod, resolution.method); }
      else if (resolution.status === "ambiguous") row.ambiguous++;
      else { row.unresolved++; bump(row.byReason, resolution.reason); if (resolution.external !== undefined) bump(row.byExternal, resolution.external); }
    }
  }
  const languages = [...perLanguage].sort(([a], [b]) => compareText(a, b)).map(([language, row]) => finish(language, row));
  const diagnostics = new Map<string, number>();
  for (const diagnostic of index.diagnostics ?? [{ phase: "cache", code: "health-unverified" }]) bump(diagnostics, `${diagnostic.phase}/${diagnostic.code}`);
  const oversizedFiles = [...index.files.values()]
    .filter((card) => card.diagnostics?.some((diagnostic) => diagnostic.phase === "scan" && diagnostic.code === "file-too-large"))
    .map((card) => ({ path: card.path, size: card.size, limitBytes: maximumIndexedFileSizeBytes }))
    .sort((a, b) => compareText(a.path, b.path));
  return {
    generation: indexGeneration(index), languages, total: finish("all", total), diagnostics: sortedRecord(diagnostics), oversizedFiles,
    limitations: ["indexed-call-sites-only", "resolution-is-heuristic-not-type-inference", "unindexed-files-not-counted", "unresolved-import-calls-are-import-target-unresolved-edges", "unbound-global-calls-are-names-with-no-binding-in-the-file"],
  };
}
