import { describe, expect, it } from "vitest";
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

it("labels selected unresolved blocks before their evidence lines", () => {
  const unresolvedOnly: CallersDetailedResult = { ...result, hits: [], unresolved: unresolved.slice(0, 2) };
  const text = formatCallersDetailedBounded(unresolvedOnly, 2_048);
  expect(text.indexOf("unresolved evidence (2)")).toBeLessThan(text.indexOf("unknown0"));
});

it("compacts hostile target names while preserving exact omissions", () => {
  const hostile: CallersDetailedResult = { ...result, target: { ...target, qualifiedName: "x".repeat(5_000) } };
  const text = formatCallersDetailedBounded(hostile, 512);
  expect(text.length).toBeLessThanOrEqual(512);
  expect(text).toContain("omitted: 100 of 100 confirmed relationships; 100 of 100 unresolved evidence items");
});

describe("call-site text", () => {
  it("prints the call-site line under each relationship and drops the text before any relationship", async () => {
    const { buildIndex } = await import("../src/index.js");
    const fs = await import("node:fs/promises"); const os = await import("node:os"); const path = await import("node:path");
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-site-text-"));
    try {
      const root = path.join(temporary, "ws"); await fs.mkdir(root);
      const callers = Array.from({ length: 40 }, (_, i) => `export function caller${i}() {\n  return target(${i}); // site ${i}\n}`).join("\n");
      await fs.writeFile(path.join(root, "a.ts"), `export function target(n: number) { return n; }\n${callers}\n`);
      const index = await buildIndex(root, { cacheDir: path.join(temporary, "cache") });
      const { callersDetailed } = await import("../src/query/callers.js");
      const result = callersDetailed(index, "a.ts#target", { direction: "in", depth: 1 });
      if (result.status !== "found") throw new Error(result.status);
      expect(result.hits[0]?.sourceText).toBe("return target(0); // site 0");
      const full = formatCallersDetailed(result);
      expect(full).toContain("  > return target(7); // site 7");
      const roomy = formatCallersDetailedBounded(result, 16_384);
      expect(roomy).toBe(full);
      const tight = formatCallersDetailedBounded(result, 2_048);
      expect(tight.length).toBeLessThanOrEqual(2_048);
      expect(tight).not.toContain("  > ");
      expect(tight).toMatch(/omitted: \d+ of 40 confirmed relationships/);
      const withoutTextLines = (tight.match(/^d1 /gm) ?? []).length;
      const withTextLines = (formatCallersDetailedBounded({ ...result, hits: result.hits.slice(0, 12) }, 2_048).match(/^ {2}> /gm) ?? []).length;
      expect(withoutTextLines).toBeGreaterThan(12);
      expect(withTextLines).toBe(12);
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  });
});
