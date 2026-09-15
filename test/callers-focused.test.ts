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
const unresolved: UnresolvedCallerEdge[] = Array.from({ length: 100 }, (_, index) => ({ edge: edge(index, false), depth: 1 }));
const result: CallersDetailedResult = { status: "found", scope: "indexed-graph", direction: "in", depth: 1, target, hits, unresolved };

it("prioritizes confirmed relationships and reports exact caller omissions", () => {
  const text = formatCallersDetailedBounded(result, 2_048);
  expect(text.length).toBeLessThanOrEqual(2_048);
  expect(text).toContain("function target.ts#target: 100 indexed edges");
  expect(text).toContain("does not prove absence");
  expect(text).toMatch(/omitted: \d+ of 100 confirmed relationships; 100 of 100 unresolved evidence items/);
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
