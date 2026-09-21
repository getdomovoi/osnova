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
  const shownGroups = text.split("\n").filter((line) => /^d1 calls caller-\d+\.ts#/.test(line)).length;
  const foldedEdges = [...text.matchAll(/^d1 calls caller-\d+\.ts: \+\d+ symbols?, (\d+) edges$/gm)].reduce((sum, match) => sum + Number(match[1]), 0);
  expect(shownGroups + foldedEdges).toBeGreaterThan(0);
  expect(text).toContain(`omitted: ${300 - shownGroups * 3 - foldedEdges} of 300 confirmed edges; 0 of 0 unresolved evidence items`);
});

it("keeps the unresolved evidence section one row per name and basis", () => {
  const unresolvedOnly: CallersDetailedResult = { ...result, hits: [], unresolved: unresolved.slice(0, 2) };
  expect(formatCallersDetailed(unresolvedOnly)).toBe([
    "indexed-graph results; relationships use heuristic resolution, not type inference",
    "target.ts#target: no indexed relationships found",
    "This does not prove absence of callers or that deletion is safe.",
    "unresolved evidence (2); not confirmed relationships",
    "d1 calls unknown0 caller-0.ts:1 [no-matching-symbol]",
    "d1 calls unknown1 caller-1.ts:2 [no-matching-symbol]",
  ].join("\n"));
});

function fileHit(file: string, name: string, line: number, via?: readonly { file: string; line: number }[]): CallerEvidenceHit {
  const base = siteHit(0, line, via);
  return { ...base, symbol: symbol(name, file), qualifiedName: `${file}#${name}`, file, edge: { ...base.edge, fromFile: file, fromSymbol: `${file}#${name}` } };
}

it("renders under-budget results without a summary header", () => {
  const small: CallersDetailedResult = { ...result, hits: [siteHit(1, 7), siteHit(0, 4)], unresolved: [] };
  const text = formatCallersDetailedBounded(small, 2_048);
  expect(text).toBe(formatCallersDetailed(small));
  expect(text).not.toContain("summary");
  expect(text).not.toContain("via (all)");
});

it("puts non-test groups before test groups and summarizes sites per directory when the budget overflows", () => {
  const hits: CallerEvidenceHit[] = [];
  for (let index = 0; index < 12; index += 1) {
    for (let line = 1; line <= 20; line += 1) hits.push(fileHit(`a/spec-${index}.test.ts`, "run", line * 4));
  }
  for (let index = 0; index < 6; index += 1) hits.push(fileHit(`z/src-${index}.ts`, "use", 5));
  const text = formatCallersDetailedBounded({ ...result, hits, unresolved: [] }, 1_536);
  expect(text.length).toBeLessThanOrEqual(1_536);
  const lines = text.split("\n");
  const summary = lines.find((line) => line.startsWith("summary"));
  expect(summary).toBe("summary: z/: 6 sites in 6 files; a/: 240 sites in 12 files");
  const firstTest = lines.findIndex((line) => line.startsWith("d1 calls a/"));
  const lastSource = lines.map((line) => line.startsWith("d1 calls z/")).lastIndexOf(true);
  expect(lastSource).toBeGreaterThanOrEqual(0);
  expect(lastSource).toBeLessThan(firstTest);
  expect(text).toContain("omitted: 0 of 246 confirmed edges");
  expect(text).toMatch(/d1 calls a\/spec-0\.test\.ts#run:4,(\d+,)*\+\d+ more \[import-binding\]/);
});

it("caps long site lists with +N more and keeps every edge represented", () => {
  const hits: CallerEvidenceHit[] = [];
  for (let line = 1; line <= 500; line += 1) hits.push(fileHit("src/wide.ts", "wide", line * 7));
  for (let index = 0; index < 4; index += 1) hits.push(fileHit(`src/narrow-${index}.ts`, "narrow", 2));
  const text = formatCallersDetailedBounded({ ...result, hits, unresolved: [] }, 2_048);
  expect(text.length).toBeLessThanOrEqual(2_048);
  expect(text).toMatch(/d1 calls src\/wide\.ts#wide:7,14,(\d+,)+\+\d+ more \[import-binding\]/);
  expect(text).toMatch(/capped: \d+ line numbers per symbol; \d+ sites not listed/);
  expect(text).toContain("omitted: 0 of 504 confirmed edges");
  for (let index = 0; index < 4; index += 1) expect(text).toContain(`d1 calls src/narrow-${index}.ts#narrow:2 [import-binding]`);
});

it("folds groups into file lines when one line per group cannot fit", () => {
  const hits: CallerEvidenceHit[] = [];
  for (let index = 0; index < 120; index += 1) hits.push(fileHit(`src/file-${index % 6}.ts`, `symbol${index}`, index + 1), fileHit(`src/file-${index % 6}.ts`, `symbol${index}`, index + 500));
  const text = formatCallersDetailedBounded({ ...result, hits, unresolved: [] }, 1_024);
  expect(text.length).toBeLessThanOrEqual(1_024);
  expect(text).toMatch(/d1 calls src\/file-\d\.ts: \+\d+ symbols, \d+ edges/);
  const shown = (text.match(/^d1 calls src\/file-\d\.ts#symbol\d+:/gm) ?? []).length;
  const folded = [...text.matchAll(/: \+(\d+) symbols, (\d+) edges/g)].reduce((sum, match) => sum + Number(match[2]), 0);
  expect(shown).toBeGreaterThan(0);
  expect(folded).toBeGreaterThan(0);
  expect(text).toContain(`omitted: ${240 - shown * 2 - folded} of 240 confirmed edges`);
});

it("hoists a via shared by every re-exporting group once under the header", () => {
  const hop = { file: "barrel.ts", line: 1 };
  const hits: CallerEvidenceHit[] = [];
  for (let index = 0; index < 30; index += 1) {
    for (let line = 1; line <= 8; line += 1) hits.push(fileHit(`src/mod-${index}.ts`, "use", line * 3, [hop]));
  }
  hits.push(fileHit("src/direct.ts", "direct", 4));
  const text = formatCallersDetailedBounded({ ...result, hits, unresolved: [] }, 2_048);
  expect(text.length).toBeLessThanOrEqual(2_048);
  expect(text.match(/barrel\.ts:1/g)).toHaveLength(1);
  expect(text).toContain("via (all): barrel.ts:1 target -> target.ts (export target)");
  expect(text.indexOf("via (all)")).toBeLessThan(text.indexOf("d1 calls "));
  expect(text).toContain("omitted: 0 of 241 confirmed edges");
});

it("does not hoist a via when another group carries a different hop", () => {
  const hits: CallerEvidenceHit[] = [];
  for (let index = 0; index < 30; index += 1) {
    for (let line = 1; line <= 8; line += 1) hits.push(fileHit(`src/mod-${index}.ts`, "use", line * 3, [{ file: index === 0 ? "other.ts" : "barrel.ts", line: 1 }]));
  }
  const text = formatCallersDetailedBounded({ ...result, hits, unresolved: [] }, 2_048);
  expect(text).not.toContain("via (all)");
});

const hitMatches = { candidates: ["a.ts#A.hit", "b.ts#B.hit"], total: 2 };
function unresolvedSite(file: string, line: number, depth = 1, name = "hit", nameMatches = hitMatches): UnresolvedCallerEdge {
  return { depth, nameMatches, edge: { ...edge(0, false), toName: name, fromFile: file, fromSymbol: `${file}#caller`, line } };
}

it("prints each distinct candidate list once and groups unresolved sites by name and file", () => {
  const many: CallersDetailedResult = { ...result, hits: [], unresolved: [
    unresolvedSite("y.ts", 12, 2), unresolvedSite("x.ts", 9), unresolvedSite("x.ts", 3), unresolvedSite("y.ts", 4),
    unresolvedSite("z.ts", 8, 1, "other", { candidates: ["o.ts#other"], total: 1 }),
    unresolvedSite("z.ts", 2, 1, "bare", { candidates: [], total: 0 }),
  ] };
  const text = formatCallersDetailed(many);
  expect(text).toBe([
    "indexed-graph results; relationships use heuristic resolution, not type inference",
    "target.ts#target: no indexed relationships found",
    "This does not prove absence of callers or that deletion is safe.",
    "unresolved evidence (6); not confirmed relationships",
    "d1 calls bare z.ts:2 [no-matching-symbol]",
    "candidates for hit (2, unverified): a.ts#A.hit, b.ts#B.hit",
    "d1 calls hit x.ts:3,9; y.ts:4 [no-matching-symbol]",
    "d2 calls hit y.ts:12 [no-matching-symbol]",
    "candidates for other (1, unverified): o.ts#other",
    "d1 calls other z.ts:8 [no-matching-symbol]",
  ].join("\n"));
  expect(formatCallersDetailedBounded(many, 2_048)).toBe(text);
});

it("keeps candidate lists once and unresolved counts exact under a budget", () => {
  const sites = Array.from({ length: 400 }, (_, index) => unresolvedSite(`file-${index % 40}.ts`, index + 1, 1 + (index % 2), "hit",
    { candidates: ["a.ts#A.hit", "b.ts#B.hit", "c.ts#C.hit", "d.ts#D.hit", "e.ts#E.hit"], total: 9 }));
  const many: CallersDetailedResult = { ...result, hits: hits.slice(0, 3), unresolved: sites };
  const full = formatCallersDetailed(many);
  expect(full.length).toBeLessThan(16_384);
  expect(full.match(/candidates for hit \(9, unverified\): a\.ts#A\.hit, b\.ts#B\.hit, c\.ts#C\.hit, d\.ts#D\.hit, e\.ts#E\.hit and 4 more/g)).toHaveLength(1);
  expect(full.match(/^d[12] calls hit .* \[no-matching-symbol\]$/gm)).toHaveLength(2);
  const text = formatCallersDetailedBounded(many, 2_048);
  expect(text.length).toBeLessThanOrEqual(2_048);
  expect(text.match(/candidates for hit/g)?.length ?? 0).toBeLessThanOrEqual(1);
  const shownRows = text.match(/^d[12] calls hit .* \[no-matching-symbol\]$/gm) ?? [];
  const omitted = Number(/(\d+) of 400 unresolved evidence items/.exec(text)?.[1]);
  expect(omitted).toBe(400 - shownRows.length * 200);
  if (shownRows.length > 0) expect(text.match(/candidates for hit/g)).toHaveLength(1);
});
