import { expect, it } from "vitest";
import { formatCallersDetailed, formatCallersDetailedBounded } from "../src/query/format.js";
import type { CallersDetailedResult, CallerEvidenceHit, OsnovaEdge, OsnovaSymbol, UnresolvedCallerEdge } from "../src/types.js";

function symbol(name: string, file = `${name}.ts`): OsnovaSymbol {
  return { name, qualifiedName: `${file}#${name}`, file, kind: "function", signature: `function ${name}()`,
    span: { startLine: 1, endLine: 1, startCol: 0, endCol: 1 }, lineCount: 1 };
}
const target = symbol("target");
function edge(index: number, resolved: boolean): OsnovaEdge {
  return { kind: "calls", fromFile: `caller-${index}.ts`, fromSymbol: `caller-${index}.ts#caller${index}`,
    toName: resolved ? "target" : `unknown${index}`, line: index + 1,
    ...(resolved ? { toFile: target.file, toSymbol: target.qualifiedName } : {}),
    evidence: { source: "syntax", resolution: resolved
      ? { status: "resolved", method: "import-binding" }
      : { status: "unresolved", reason: "no-matching-symbol" } },
  };
}
const hits: CallerEvidenceHit[] = Array.from({ length: 100 }, (_, index) => ({
  symbol: symbol(`caller${index}`, `caller-${index}.ts`), qualifiedName: `caller-${index}.ts#caller${index}`,
  file: `caller-${index}.ts`, line: 1, kind: "calls", depth: 1, resolved: true, edge: edge(index, true),
}));
const unresolved: UnresolvedCallerEdge[] = Array.from({ length: 100 }, (_, index) => ({ edge: edge(index, false), depth: 1, nameMatches: { candidates: [], total: 0 } }));
const result: CallersDetailedResult = { status: "found", scope: "indexed-graph", direction: "in", depth: 1, target, hits, unresolved };

it("prioritizes confirmed relationships and reports exact caller omissions", () => {
  const text = formatCallersDetailedBounded(result, 2_048);
  expect(text.length).toBeLessThanOrEqual(2_048);
  expect(text).toContain("function target.ts#target: 100 indexed edges");
  expect(text).toContain("does not prove absence");
  expect(text).toMatch(/omitted: \d+ of 100 confirmed edges; 100 of 100 unresolved evidence items/);
  expect(text).toContain("Use callersDetailed API for complete structured results");
  expect(text).not.toContain("[output truncated:");
  expect(formatCallersDetailedBounded(result, 2_048)).toBe(text);
});

it("bounds ambiguous candidate lists without selecting a target", () => {
  const ambiguous: CallersDetailedResult = { status: "ambiguous", candidates: Array.from({ length: 100 }, (_, index) => symbol(`target${index}`)) };
  const text = formatCallersDetailedBounded(ambiguous, 2_048);
  expect(text.length).toBeLessThanOrEqual(2_048);
  expect(text).toMatch(/omitted: \d+ of 100 ambiguous candidates/);
  expect(text).toContain("use a qualified name");
});

it("matches the complete formatter when the result fits", () => {
  const small: CallersDetailedResult = { ...result, hits: hits.slice(0, 1), unresolved: [] };
  expect(formatCallersDetailedBounded(small, 2_048)).toBe(formatCallersDetailed(small));
});

it.each([0, 511, 1.5, NaN, Infinity])("rejects invalid caller budgets: %s", (budget) => {
  expect(() => formatCallersDetailedBounded(result, budget)).toThrow(RangeError);
});

it("labels selected unresolved blocks before their evidence lines", () => {
  const unresolvedOnly: CallersDetailedResult = { ...result, hits: [], unresolved: unresolved.slice(0, 2) };
  const text = formatCallersDetailedBounded(unresolvedOnly, 2_048);
  expect(text.indexOf("unresolved evidence (2)")).toBeLessThan(text.indexOf("unknown0"));
});

it("compacts hostile target names while preserving exact omissions", () => {
  const hostile: CallersDetailedResult = { ...result, target: { ...target, qualifiedName: "x".repeat(5_000) } };
  const text = formatCallersDetailedBounded(hostile, 512);
  expect(text.length).toBeLessThanOrEqual(512);
  expect(text).toContain("omitted: 100 of 100 confirmed edges; 100 of 100 unresolved evidence items");
});

function siteHit(index: number, line: number, via?: readonly { file: string; line: number }[]): CallerEvidenceHit {
  const resolution = via === undefined
    ? { status: "resolved" as const, method: "import-binding" as const }
    : { status: "resolved" as const, method: "re-export-binding" as const, via: via.map((hop) => ({ ...hop, kind: "named" as const, source: "./target.js", exportedName: "target", targetFile: target.file, importedName: "target" })) };
  return {
    symbol: symbol(`caller${index}`, `caller-${index}.ts`), qualifiedName: `caller-${index}.ts#caller${index}`,
    file: `caller-${index}.ts`, line, kind: "calls", depth: 1, resolved: true,
    edge: { ...edge(index, true), line, evidence: { source: "syntax", resolution } },
  };
}

it("groups edges from one caller into a single line list", () => {
  const grouped: CallersDetailedResult = { ...result, hits: [siteHit(1, 7), siteHit(0, 4), siteHit(1, 3), siteHit(1, 3)], unresolved: [] };
  expect(formatCallersDetailed(grouped)).toBe([
    "indexed-graph results; relationships use heuristic resolution, not type inference",
    "function target.ts#target: 4 indexed edges",
    "d1 calls caller-0.ts#caller0:4 [import-binding]",
    "d1 calls caller-1.ts#caller1:3,7 [import-binding]",
    "This does not prove absence of callers or that deletion is safe.",
  ].join("\n"));
});

it("hoists via hops once per group only when every edge shares them", () => {
  const hop = { file: "barrel.ts", line: 1 };
  const shared: CallersDetailedResult = { ...result, hits: [siteHit(2, 5, [hop]), siteHit(2, 9, [hop])], unresolved: [] };
  const sharedText = formatCallersDetailed(shared);
  expect(sharedText).toContain("d1 calls caller-2.ts#caller2:5,9 [re-export-binding]\n  via barrel.ts:1 target -> target.ts (export target)");
  expect(sharedText.match(/via barrel/g)).toHaveLength(1);
  const mixed: CallersDetailedResult = { ...result, hits: [siteHit(2, 5, [hop]), siteHit(2, 9, [{ file: "other.ts", line: 2 }]), siteHit(2, 12, [hop])], unresolved: [] };
  expect(formatCallersDetailed(mixed)).toContain([
    "d1 calls caller-2.ts#caller2:5,9,12 [re-export-binding]",
    "  5,12: via barrel.ts:1 target -> target.ts (export target)",
    "  9: via other.ts:2 target -> target.ts (export target)",
  ].join("\n"));
});

it("counts omitted edges, not omitted groups, in the bounded footer", () => {
  const many: CallersDetailedResult = {
    ...result, unresolved: [],
    hits: Array.from({ length: 300 }, (_, index) => siteHit(index % 100, index + 1)),
  };
  const text = formatCallersDetailedBounded(many, 2_048);
  expect(text.length).toBeLessThanOrEqual(2_048);
  const shownGroups = text.split("\n").filter((line) => line.startsWith("d1 calls ")).length;
  expect(shownGroups).toBeGreaterThan(0);
  expect(text).toContain(`omitted: ${300 - shownGroups * 3} of 300 confirmed edges; 0 of 0 unresolved evidence items`);
});

it("keeps the unresolved evidence section one row per edge", () => {
  const unresolvedOnly: CallersDetailedResult = { ...result, hits: [], unresolved: unresolved.slice(0, 2) };
  expect(formatCallersDetailed(unresolvedOnly)).toBe([
    "indexed-graph results; relationships use heuristic resolution, not type inference",
    "target.ts#target: no indexed relationships found",
    "This does not prove absence of callers or that deletion is safe.",
    "unresolved evidence (2); not confirmed relationships",
    "d1 calls unknown0 caller-0.ts:1",
    "  reason: no-matching-symbol",
    "d1 calls unknown1 caller-1.ts:2",
    "  reason: no-matching-symbol",
  ].join("\n"));
});
