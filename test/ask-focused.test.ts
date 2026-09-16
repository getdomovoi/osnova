import { expect, it } from "vitest";
import { ask, askDetailed } from "../src/query/ask.js";
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

it("distinguishes query-limit omissions in structured results", () => {
  const detailed = askDetailed(index, "shared target", { limit: 8 });
  expect(detailed).toMatchObject({ totalCandidates: 100, omittedHits: 92, truncated: true });
});

it("reports eligible files for empty queries without inventing candidates", () => {
  expect(askDetailed(index, "", { in: "source-0.ts" })).toMatchObject({
    hits: [], filesSearched: 1, totalCandidates: 0, omittedHits: 0, truncated: false,
  });
});
