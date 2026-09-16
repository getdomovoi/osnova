import { describe, expect, it } from "vitest";
import { findText, findTextDetailed } from "../src/index.js";
import { OsnovaIndexImpl } from "../src/index/indexImpl.js";
import type { FileCard } from "../src/types.js";

const files = new Map<string, FileCard>();
for (let i = 0; i < 51; i += 1) {
  const path = `file-${i}.txt`;
  files.set(path, {
    path, language: "fallback", hash: "fixture", size: 0,
    lineCount: 11, text: Array(11).fill("needle").join("\n"), symbols: [],
  });
}
const index = new OsnovaIndexImpl("/fixture", files, []);

describe("search completeness", () => {
  it("returns every indexed match by default through the detailed API", () => {
    const result = findTextDetailed(index, "needle");
    expect(result.groups).toHaveLength(51);
    expect(result.groups.every((group) => group.matches.length === 11)).toBe(true);
    expect(result.totalMatches).toBe(561);
    expect(result.omittedMatches).toBe(0);
    expect(result.omittedGroups).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.scope).toBe("indexed-text");
  });

  it("counts omissions across both group and match limits", () => {
    const result = findTextDetailed(index, "needle", { limit: 50, matchesPerGroup: 10 });
    expect(result.groups).toHaveLength(50);
    expect(result.totalGroups).toBe(51);
    expect(result.omittedGroups).toBe(1);
    expect(result.omittedMatches).toBe(61);
    expect(result.truncated).toBe(true);
    expect(findText(index, "needle")).toEqual(result.groups);
  });

  it("handles zero limits without pretending there were no matches", () => {
    expect(findTextDetailed(index, "needle", { limit: 0 })).toMatchObject({
      groups: [], totalMatches: 561, omittedMatches: 561, truncated: true,
    });
  });

  it.each([-1, 1.5, NaN, Infinity])("rejects invalid limits: %s", (limit) => {
    expect(() => findTextDetailed(index, "needle", { limit })).toThrow(RangeError);
    expect(() => findTextDetailed(index, "needle", { matchesPerGroup: limit })).toThrow(RangeError);
  });

  it("counts matches only inside the requested scope", () => {
    const result = findTextDetailed(index, "needle", { in: "file-0.txt" });
    expect(result.totalMatches).toBe(11);
    expect(result.totalGroups).toBe(1);
  });
});
