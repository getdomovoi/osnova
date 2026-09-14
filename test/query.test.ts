import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { buildIndex } from "../src/index/build.js";
import { ask } from "../src/query/ask.js";
import { findText } from "../src/query/findText.js";
import { skeleton } from "../src/query/skeleton.js";
import { callers } from "../src/query/callers.js";
import { map } from "../src/query/map.js";
import { renderMapCard } from "../src/query/mapCard.js";
import { maximumOsnovaMapCardCodeUnits } from "../src/types.js";
import type { OsnovaIndex } from "../src/types.js";

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

  it("throws for unknown symbols", () => {
    expect(() => callers(index, "doesNotExist")).toThrow(/no indexed symbol/);
  });
});

describe("map", () => {
  it("clusters directories and ranks hotspots", () => {
    const result = map(index);
    expect(result.fileCount).toBe(8);
    expect(result.clusters[0]?.dir).toBe("src/");
    expect(result.hotspots.length).toBeGreaterThan(0);
    const top = result.hotspots[0];
    expect(top !== undefined && top.inEdges + top.outEdges > 0).toBe(true);
  });

  it("caps clusters at maxDirs", () => {
    const result = map(index, { maxDirs: 1 });
    expect(result.clusters).toHaveLength(1);
    expect(result.droppedDirs).toBe(1);
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
  });

  it("reports staleness from disk when not overridden", async () => {
    const card = await renderMapCard(index);
    expect(card).toMatch(/stale: \d+ files|fresh/);
  });
});
