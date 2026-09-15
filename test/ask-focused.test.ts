import { expect, it } from "vitest";
import { ask, askDetailed } from "../src/query/ask.js";
import { formatAskDetailedBounded } from "../src/query/format.js";
import { OsnovaIndexImpl } from "../src/index/indexImpl.js";
import type { FileCard, OsnovaSymbol } from "../src/types.js";

const files = new Map<string, FileCard>();
for (let index = 0; index < 100; index += 1) {
  const file = `source-${index}.ts`;
  const text = `export function sharedTarget${index}(value: string) { return "${"x".repeat(500)}"; }\n`;
  const symbol: OsnovaSymbol = { name: `sharedTarget${index}`, qualifiedName: `${file}#sharedTarget${index}`, file,
    kind: "function", signature: `export function sharedTarget${index}(value: string)`,
    span: { startLine: 1, endLine: 1, startCol: 0, endCol: 1 }, lineCount: 1 };
  files.set(file, { path: file, language: "typescript", hash: "fixture", size: text.length, lineCount: 1, text, symbols: [symbol] });
}
const index = new OsnovaIndexImpl("/fixture", files, []);

it("retrieves every ranked candidate by default through askDetailed", () => {
  const detailed = askDetailed(index, "shared target");
  expect(detailed.hits).toHaveLength(100);
  expect(detailed).toMatchObject({ totalCandidates: 100, omittedHits: 0, truncated: false, filesSearched: 100 });
  expect(ask(index, "shared target").hits).toHaveLength(8);
});

it("distinguishes query-limit and MCP presentation omissions", () => {
  const detailed = askDetailed(index, "shared target", { limit: 8 });
  const text = formatAskDetailedBounded(detailed, 4_096);
  expect(text.length).toBeLessThanOrEqual(4_096);
  expect(text).toContain("indexed definition/text search:");
  expect(text).toMatch(/omitted: \d+ of 100 ranked candidates \(92 by query limit; \d+ by MCP budget\)/);
  expect(text).toContain("Use askDetailed API for complete structured results");
  expect(text).not.toContain("[output truncated:");
});

it("compacts hostile source lines while preserving the top candidate", () => {
  const detailed = askDetailed(index, "sharedTarget0", { limit: 1 });
  const text = formatAskDetailedBounded(detailed, 512);
  expect(text.length).toBeLessThanOrEqual(512);
  expect(text).toContain("source-0.ts#sharedTarget0");
  expect(text).toContain("source lines compacted");
});

it.each([0, 511, 1.5, NaN, Infinity])("rejects invalid ask presentation budgets: %s", (budget) => {
  expect(() => formatAskDetailedBounded(askDetailed(index, "shared target", { limit: 8 }), budget)).toThrow(RangeError);
});
