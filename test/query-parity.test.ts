import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index/build.js";
import { loadIndex } from "../src/api.js";
import { ask, findTextDetailed, skeleton, scopedAsk, taskContext } from "../src/index.js";
import { impact } from "../src/query/impact.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-repo");
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

describe("loaded index answers like a built index", () => {
  it("matches on every text-reading query", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-parity-"));
    dirs.push(dir);
    const cacheDir = path.join(dir, "cache");
    const built = await buildIndex(FIXTURE, { cacheDir });
    const loaded = (await loadIndex(FIXTURE, { cacheDir }))!;
    expect(ask(loaded, "retry timer", { limit: 5 })).toEqual(ask(built, "retry timer", { limit: 5 }));
    expect(findTextDetailed(loaded, "Retry")).toEqual(findTextDetailed(built, "Retry"));
    expect(skeleton(loaded, "src/util.ts")).toEqual(skeleton(built, "src/util.ts"));
    expect(scopedAsk(loaded, "retry")).toEqual(scopedAsk(built, "retry"));
    expect(taskContext(loaded, { question: "retry", task: "understand" })).toEqual(taskContext(built, { question: "retry", task: "understand" }));
    expect(impact(loaded, loaded)).toEqual(impact(built, built));
  });
});
