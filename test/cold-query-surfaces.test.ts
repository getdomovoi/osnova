import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { askDetailed, buildIndex, loadIndex, scopedAsk } from "../src/index.js";
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
