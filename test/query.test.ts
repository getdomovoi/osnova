import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { buildIndex } from "../src/index/build.js";
import { ask } from "../src/query/ask.js";
import { findText, findTextDetailed } from "../src/query/findText.js";
import { clipThreadText, formatAsk, formatFindText, formatFindTextResult } from "../src/query/format.js";
import { skeleton } from "../src/query/skeleton.js";
import { callers, callersDetailed } from "../src/query/callers.js";
import { map } from "../src/query/map.js";
import { renderMapCard } from "../src/query/mapCard.js";
import { maximumOsnovaMapCardCodeUnits } from "../src/types.js";
import type { AskHit, AskResult, FindTextGroup, OsnovaIndex, OsnovaSymbol } from "../src/types.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-repo");

let index: OsnovaIndex;
beforeAll(async () => {
  index = await buildIndex(FIXTURE);
});

describe("ask", () => {
  it("ranks the definition of a named symbol first", () => {
    const result = ask(index, "pad string width");
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]?.file).toBe("src/util.ts");
    expect(result.hits[0]?.symbol?.qualifiedName).toBe("src/util.ts#pad");
    expect(result.hits[0]?.excerpt.split("\n").length).toBeLessThanOrEqual(8);
  });

  it("inlines whole spans with full", () => {
    const result = ask(index, "ticks counter", { full: true });
    const hit = result.hits.find((h) => h.symbol?.qualifiedName === "src/util.ts#RetryTimer");
    expect(hit).toBeDefined();
    expect(hit?.excerpt.split("\n").length).toBeGreaterThanOrEqual(4);
    expect(hit?.excerptStartLine).toBe(hit?.symbol?.span.startLine);
  });

  it("filters by path with in", () => {
    const result = ask(index, "Server start", { in: "src" });
    expect(result.hits.every((h) => h.file.startsWith("src/"))).toBe(true);
    const python = ask(index, "Server start", { in: "src/server.py" });
    expect(python.hits.every((h) => h.file === "src/server.py")).toBe(true);
  });
});

describe("ground formatting", () => {
  function symbolAt(qualifiedName: string, startLine: number, endLine: number): OsnovaSymbol {
    const name = qualifiedName.slice(qualifiedName.lastIndexOf(".") + 1);
    return { name, qualifiedName, kind: "constant", file: "src/a.ts", span: { startLine, endLine, startCol: 0, endCol: 1 }, signature: name, lineCount: endLine - startLine + 1 };
  }
  function hitFor(qualifiedName: string, line: number, endLine = line): AskHit {
    return { file: "src/a.ts", line, score: 1, symbol: symbolAt(qualifiedName, line, endLine), excerpt: `body of ${qualifiedName}`, excerptStartLine: line };
  }
  const parent = hitFor("src/a.ts#outer", 10);
  const first = hitFor("src/a.ts#outer.first", 12);
  const second = hitFor("src/a.ts#outer.second.deep", 20);
  const other = hitFor("src/a.ts#other", 50);

  it("folds hits nested under a shown parent into one also line", () => {
    const result: AskResult = { hits: [parent, first, other, second], filesSearched: 1 };
    const text = formatAsk(result);
    expect(text).toBe([
      "src/a.ts:10 constant src/a.ts#outer\nL10: body of src/a.ts#outer\nalso: .first L12, .second.deep L20",
      "src/a.ts:50 constant src/a.ts#other\nL50: body of src/a.ts#other",
    ].join("\n\n"));
    expect(result.hits).toHaveLength(4);
  });

  it("prints a nested hit in full when its parent is not shown", () => {
    const text = formatAsk({ hits: [other, first], filesSearched: 1 });
    expect(text).toBe([
      "src/a.ts:50 constant src/a.ts#other\nL50: body of src/a.ts#other",
      "src/a.ts:12 constant src/a.ts#outer.first\nL12: body of src/a.ts#outer.first",
    ].join("\n\n"));
    expect(text).not.toContain("also:");
  });

  it("keeps a child that outranks its parent as its own hit", () => {
    const text = formatAsk({ hits: [first, other, parent, second], filesSearched: 1 });
    const blocks = text.split("\n\n");
    expect(blocks.map((block) => block.split("\n")[0])).toEqual([
      "src/a.ts:12 constant src/a.ts#outer.first",
      "src/a.ts:50 constant src/a.ts#other",
      "src/a.ts:10 constant src/a.ts#outer",
    ]);
    expect(blocks[2]).toContain("also: .second.deep L20");
    expect(text).not.toContain("also: .first");
  });
});

describe("findText", () => {
  it("groups matches by enclosing symbol ranked by incoming edges", () => {
    const groups = findText(index, "RetryTimer");
    expect(groups.length).toBeGreaterThan(0);
    const classGroup = groups.find((g) => g.symbol?.qualifiedName === "src/util.ts#RetryTimer");
    expect(classGroup).toBeDefined();
    expect(classGroup?.file).toBe("src/util.ts");
    expect(classGroup?.incomingEdges).toBeGreaterThanOrEqual(1);
    expect(classGroup?.matches[0]?.line).toBeGreaterThan(0);
    const rankOrder = groups.map((g) => g.incomingEdges);
    const sorted = [...rankOrder].sort((a, b) => b - a);
    expect(rankOrder).toEqual(sorted);
  });

  it("supports fixed and ignoreCase modes", () => {
    const fixed = findText(index, "MAX_RETRIES", { fixed: true });
    expect(fixed.some((g) => g.file === "src/util.ts")).toBe(true);
    const ci = findText(index, "max_retries", { fixed: true, ignoreCase: true });
    expect(ci.length).toBeGreaterThan(0);
    const literalDot = findText(index, "s.rv", { fixed: true });
    expect(literalDot).toHaveLength(0);
    const regex = findText(index, "S.rver");
    expect(regex.some((g) => g.file === "src/server.py")).toBe(true);
  });

  it("rejects invalid regex with a clear error", () => {
    expect(() => findText(index, "[")).toThrow(/invalid pattern/);
  });
});

describe("thread formatting", () => {
  const long = "abcdefghij".repeat(30);

  it("clips a long line to a window around the match", () => {
    const near = clipThreadText(long, 5, 9);
    expect(near.startsWith("abcde")).toBe(true);
    expect(near.endsWith("…")).toBe(true);
    expect(near.length).toBe(121);

    const end = clipThreadText(long, 290, 295);
    expect(end.startsWith("…")).toBe(true);
    expect(end.endsWith("ghij")).toBe(true);
    expect(end.length).toBe(121);

    const middle = clipThreadText(long, 150, 154);
    expect(middle.startsWith("…")).toBe(true);
    expect(middle.endsWith("…")).toBe(true);
    expect(middle.length).toBe(122);
    expect(middle.slice(1, -1)).toBe(long.slice(92, 212));
  });

  it("never cuts inside a match longer than the window", () => {
    const wide = clipThreadText(long, 10, 200);
    expect(wide).toBe(`…${long.slice(10, 200)}…`);
  });

  it("keeps short lines whole and trims indentation", () => {
    expect(clipThreadText("    const x = 1;", 10, 11)).toBe("const x = 1;");
  });

  it("merges same-line matches into one row listing the columns", () => {
    const groups: FindTextGroup[] = [{
      symbol: null,
      file: "a.ts",
      incomingEdges: 0,
      matches: [
        { line: 3, col: 2, length: 3, text: "  foo foo" },
        { line: 3, col: 6, length: 3, text: "  foo foo" },
        { line: 5, col: 0, length: 3, text: "foo" },
      ],
    }];
    expect(formatFindText(groups)).toBe("<module> a.ts (0 in)\na.ts:3:3,7: foo foo\na.ts:5:1: foo");
  });

  it("keeps header counts equal to findTextDetailed totals after merging", () => {
    const result = findTextDetailed(index, "\\w", { limit: 50, matchesPerGroup: 10 });
    const shown = result.groups.reduce((n, g) => n + g.matches.length, 0);
    const rows = result.groups.reduce((n, g) => n + new Set(g.matches.map((m) => m.line)).size, 0);
    expect(shown).toBeGreaterThan(rows);
    const text = formatFindTextResult(result);
    expect(text).toContain(`indexed-text search: ${result.totalMatches - result.omittedMatches}/${result.totalMatches} matches`);
    expect(text.split("\n").filter((l) => /^[^ ]+:\d+:\d+(,\d+)*: /.test(l)).length).toBe(rows);
  });
});

describe("skeleton", () => {
  it("returns every definition sorted by span", () => {
    const result = skeleton(index, "src/util.ts");
    expect(result.entries.length).toBe(8);
    const lines = result.entries.map((e) => e.symbol.span.startLine);
    const sorted = [...lines].sort((a, b) => a - b);
    expect(lines).toEqual(sorted);
    expect(result.entries[0]?.signature).toBe("MAX_RETRIES = 3");
  });

  it("throws for unindexed files", () => {
    expect(() => skeleton(index, "nope.ts")).toThrow(/not indexed/);
  });
});

describe("callers", () => {
  it("finds direct callers inbound", () => {
    const result = callers(index, "src/util.ts#pad");
    expect(result.target.kind).toBe("function");
    expect(result.hits.some((h) => h.qualifiedName === "src/app.ts#run")).toBe(true);
  });

  it("walks transitively with depth", () => {
    const depth1 = callers(index, "src/util.ts#internalHelper");
    expect(depth1.hits.some((h) => h.qualifiedName === "src/util.ts#compute")).toBe(true);
    const depth2 = callers(index, "src/util.ts#internalHelper", { depth: 2 });
    expect(depth2.hits.some((h) => h.qualifiedName === "src/app.ts#run")).toBe(true);
  });

  it("finds callees with direction out", () => {
    const result = callers(index, "src/app.ts#run", { direction: "out" });
    expect(result.hits.some((h) => h.qualifiedName === "src/util.ts#pad")).toBe(true);
  });

  it("resolves bare names deterministically", () => {
    const result = callers(index, "compute");
    expect(result.target.qualifiedName).toBe("src/util.ts#compute");
  });

  it("resolves Class.method without a file prefix", () => {
    const result = callers(index, "RetryTimer.tick");
    expect(result.target.qualifiedName).toBe("src/util.ts#RetryTimer.tick");
    expect(callersDetailed(index, "RetryTimer.tick")).toMatchObject({ status: "found", target: { qualifiedName: "src/util.ts#RetryTimer.tick" } });
  });

  it("throws for unknown symbols and names the search tools", () => {
    expect(() => callers(index, "doesNotExist")).toThrow(/no indexed symbol .* thread or ground/);
    expect(() => callers(index, "Nope.method")).toThrow(/no indexed symbol/);
  });
});

describe("map", () => {
  it("clusters directories and ranks hotspots", () => {
    const result = map(index);
    expect(result.fileCount).toBe(28);
    expect(result.clusters[0]?.dir).toBe("src/");
    expect(result.hotspots.length).toBeGreaterThan(0);
    expect(result.droppedHotspots).toBeGreaterThanOrEqual(0);
    const top = result.hotspots[0];
    expect(top !== undefined && top.inEdges + top.outEdges > 0).toBe(true);
  });

  it("caps clusters at maxDirs", () => {
    const result = map(index, { maxDirs: 1 });
    expect(result.clusters).toHaveLength(1);
    expect(result.droppedDirs).toBe(3);
  });
});

describe("renderMapCard", () => {
  it("renders a deterministic card under the default cap", async () => {
    const card = await renderMapCard(index, { staleCount: 0 });
    expect(card.length).toBeLessThanOrEqual(maximumOsnovaMapCardCodeUnits);
    expect(card).toContain("osnova sample-repo");
    expect(card).toContain("fresh");
    expect(card).toContain("src/");
    const again = await renderMapCard(index, { staleCount: 0 });
    expect(card).toBe(again);
  });

  it("elastically drops detail lines to fit a tiny cap", async () => {
    const card = await renderMapCard(index, { staleCount: 0, maxCodeUnits: 400 });
    expect(card.length).toBeLessThanOrEqual(400);
    expect(card).toContain("osnova sample-repo");
    expect(card).toContain("dropped:");
  });

  it("reports staleness from disk when not overridden", async () => {
    const card = await renderMapCard(index);
    expect(card).toMatch(/stale: \d+ files|fresh/);
  });
});
