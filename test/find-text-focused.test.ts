import { expect, it } from "vitest";
import { findTextDetailed } from "../src/query/findText.js";
import { formatFindTextResultBounded } from "../src/query/format.js";
import { OsnovaIndexImpl } from "../src/index/indexImpl.js";
import type { FileCard } from "../src/types.js";

const files = new Map<string, FileCard>();
for (let index = 0; index < 51; index += 1) {
  const file = `file-${index}.txt`;
  const text = Array(11).fill(`needle ${"x".repeat(500)}`).join("\n");
  files.set(file, { path: file, language: "fallback", hash: "fixture", size: text.length, lineCount: 11, text, symbols: [] });
}
const index = new OsnovaIndexImpl("/fixture", files, []);

it("preserves displayed file:line evidence and exact total omissions", () => {
  const result = findTextDetailed(index, "needle", { fixed: true, limit: 50, matchesPerGroup: 10 });
  const text = formatFindTextResultBounded(result, 3_072);
  expect(text.length).toBeLessThanOrEqual(3_072);
  expect(text).toMatch(/indexed-text search: \d+\/561 matches, \d+\/51 groups/);
  expect(text).toMatch(/omitted: \d+ of 561 matches; \d+ of 51 groups/);
  expect(text).toContain("query selection omitted 61 matches and 1 groups");
  expect(text).toContain("file-0.txt:1:");
  expect(text).toContain("source lines compacted");
  expect(text).not.toContain("[output truncated:");
  expect(formatFindTextResultBounded(result, 3_072)).toBe(text);
});

it("keeps a complete small result explicitly complete", () => {
  const result = findTextDetailed(index, "needle", { fixed: true, in: "file-0.txt" });
  const text = formatFindTextResultBounded(result, 3_072);
  expect(text).toContain("11/11 matches, 1/1 groups");
  expect(text).not.toContain("omitted:");
});

it("qualifies an empty search without truncation", () => {
  const text = formatFindTextResultBounded(findTextDetailed(index, "absent", { fixed: true }), 3_072);
  expect(text).toContain("0/0 matches, 0/0 groups");
  expect(text).toContain("no matches in indexed text");
  expect(text).not.toContain("omitted:");
});

it.each([0, 511, 1.5, NaN, Infinity])("rejects invalid find-text budgets: %s", (budget) => {
  expect(() => formatFindTextResultBounded(findTextDetailed(index, "needle", { fixed: true }), budget)).toThrow(RangeError);
});
