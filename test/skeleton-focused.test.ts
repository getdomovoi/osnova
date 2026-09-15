import { expect, it } from "vitest";
import { formatSkeletonBounded } from "../src/query/format.js";
import { OsnovaIndexImpl } from "../src/index/indexImpl.js";
import { skeleton } from "../src/query/skeleton.js";
import type { FileCard, OsnovaEdge, OsnovaSymbol } from "../src/types.js";

const symbols: OsnovaSymbol[] = Array.from({ length: 150 }, (_, index) => ({
  name: index === 149 ? "importantTarget" : `ordinaryFunction${index}`,
  qualifiedName: `large.ts#${index === 149 ? "importantTarget" : `ordinaryFunction${index}`}`,
  kind: "function", file: "large.ts", signature: `export function ${index === 149 ? "importantTarget" : `ordinaryFunction${index}`}(value: string): string`,
  span: { startLine: index * 2 + 1, endLine: index * 2 + 1, startCol: 0, endCol: 1 }, lineCount: 1,
}));
const card: FileCard = { path: "large.ts", language: "typescript", hash: "fixture", size: 0, lineCount: 300, text: "", symbols };
const edges: OsnovaEdge[] = Array.from({ length: 20 }, (_, index) => ({
  kind: "calls", fromFile: "large.ts", fromSymbol: `large.ts#ordinaryFunction${index}`, toName: "importantTarget",
  line: index * 2 + 1, toFile: "large.ts", toSymbol: "large.ts#importantTarget",
  evidence: { source: "syntax", resolution: { status: "resolved", method: "lexical-definition" } },
}));
const index = new OsnovaIndexImpl("/fixture", new Map([[card.path, card]]), edges);

it("selects high-degree signatures within a deterministic budget", () => {
  const result = formatSkeletonBounded(index, skeleton(index, "large.ts"), 4096);
  expect(result.length).toBeLessThanOrEqual(4096);
  expect(result).toContain("importantTarget");
  expect(result).toMatch(/omitted: \d+ of 150 signatures/);
  expect(result).toContain("selected by indexed edge degree");
  expect(formatSkeletonBounded(index, skeleton(index, "large.ts"), 4096)).toBe(result);
});

it("preserves the complete source-order view when it fits", () => {
  const full = formatSkeletonBounded(index, skeleton(index, "large.ts"), 20_000);
  expect(full).not.toContain("omitted:");
  expect(full.indexOf("ordinaryFunction0")).toBeLessThan(full.indexOf("importantTarget"));
});

it.each([0, 255, 1.5, NaN, Infinity])("rejects invalid skeleton budgets: %s", (budget) => {
  expect(() => formatSkeletonBounded(index, skeleton(index, "large.ts"), budget)).toThrow(RangeError);
});

it("compacts hostile file paths without clipping omission metadata", () => {
  const result = skeleton(index, "large.ts");
  const text = formatSkeletonBounded(index, { ...result, file: "nested/" + "x".repeat(2_000) + "/large.ts" }, 256);
  expect(text.length).toBeLessThanOrEqual(256);
  expect(text).toContain("omitted: 150 of 150 signatures");
  expect(text).toContain("Use skeleton API");
});
