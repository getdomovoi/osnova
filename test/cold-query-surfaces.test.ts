import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { askDetailed, buildIndex, findTextDetailed, loadIndex, scopedAsk, skeleton } from "../src/index.js";
import { formatSkeletonBounded } from "../src/query/format.js";
import { resetQueryCaches } from "../src/query/context.js";
import type { OsnovaIndexImpl } from "../src/index/indexImpl.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-repo");

let temporary: string;
let cacheDir: string;

beforeAll(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-cold-surfaces-"));
  cacheDir = path.join(temporary, "cache");
  await buildIndex(FIXTURE, { cacheDir });
});

afterAll(async () => {
  await fs.rm(temporary, { recursive: true, force: true });
});

async function coldIndex(): Promise<OsnovaIndexImpl> {
  resetQueryCaches();
  const index = await loadIndex(FIXTURE, { cacheDir });
  expect(index).toBeDefined();
  expect((index as OsnovaIndexImpl).edgesLoaded()).toBe(false);
  return index as OsnovaIndexImpl;
}

describe("ground surfaces answer from the core section", () => {
  it.each([
    ["an unscoped ask", (index: OsnovaIndexImpl) => askDetailed(index, "retry timer", { limit: 8 })],
    ["an ask scoped to a directory", (index: OsnovaIndexImpl) => askDetailed(index, "retry timer", { in: "src", limit: 8 })],
    ["an ask scoped to one file", (index: OsnovaIndexImpl) => askDetailed(index, "pad string width", { in: "src/util.ts", limit: 8 })],
    ["a scopedAsk", (index: OsnovaIndexImpl) => scopedAsk(index, "retry timer", { limit: 8 })],
  ])("%s leaves the edge section unloaded", async (_name, query) => {
    const index = await coldIndex();
    query(index);
    expect(index.edgesLoaded()).toBe(false);
  });
});

describe("degree-ranked surfaces answer from the core section", () => {
  it.each([
    ["a text search", (index: OsnovaIndexImpl) => findTextDetailed(index, "compute", { limit: 8, matchesPerGroup: 4 })],
    ["a bounded skeleton", (index: OsnovaIndexImpl) => formatSkeletonBounded(index, skeleton(index, "src/util.ts"), 256)],
  ])("%s leaves the edge section unloaded", async (_name, query) => {
    const index = await coldIndex();
    query(index);
    expect(index.edgesLoaded()).toBe(false);
  });

  it("reports the same degree as the loaded edge section, for every symbol", async () => {
    const index = await coldIndex();
    const cold = new Map([...index.symbols.keys()].map((q) => [q, index.degree(q)]));
    expect(index.edgesLoaded()).toBe(false);
    expect(cold.size).toBeGreaterThan(0);
    for (const [q, degree] of cold) {
      expect(degree, q).toEqual({ incoming: index.incoming(q).length, outgoing: index.outgoing(q).length });
    }
    expect(index.edgesLoaded()).toBe(true);
    expect([...cold.values()].some((degree) => degree.incoming > 0 && degree.outgoing > 0)).toBe(true);
  });

  it("ranks text search groups by the persisted degree", async () => {
    const index = await coldIndex();
    const groups = findTextDetailed(index, "compute", { limit: 8, matchesPerGroup: 4 }).groups;
    expect(index.edgesLoaded()).toBe(false);
    const expected = groups.map((group) => group.symbol === null ? 0 : index.incoming(group.symbol.qualifiedName).length);
    expect(groups.map((group) => group.incomingEdges)).toEqual(expected);
    expect(expected.some((count) => count > 0)).toBe(true);
  });
});
