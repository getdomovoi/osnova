import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const state = vi.hoisted(() => ({ opens: [] as number[] }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const openSync = (...args: Parameters<typeof actual.openSync>): number => {
    state.opens.push(1);
    return actual.openSync(...args);
  };
  return { ...actual, openSync };
});

import { buildIndex } from "../src/index/build.js";
import { refreshWorkspace, loadIndex } from "../src/api.js";
import { serializeText } from "../src/index/textStore.js";
import { workspaceDirFor } from "../src/cache/cache.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  state.opens.length = 0;
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("copy-on-publish", () => {
  it("publishes an edited refresh through one shared file descriptor instead of one open per unchanged card", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-copy-")); dirs.push(dir);
    const repo = path.join(dir, "repo"); const cacheDir = path.join(dir, "cache");
    await fs.cp(path.join(import.meta.dirname, "fixtures", "sample-repo"), repo, { recursive: true });
    await buildIndex(repo, { cacheDir });
    await fs.appendFile(path.join(repo, "src", "util.ts"), "\nexport function added(): number { return 1; }\n");
    state.opens.length = 0;
    const refreshed = await refreshWorkspace(repo, { cacheDir });
    expect(refreshed.files.get("src/util.ts")!.text).toContain("added");
    expect(refreshed.files.size).toBeGreaterThan(5);
    expect(state.opens.length).toBeLessThan(refreshed.files.size - 5);
    const published = (await fs.readFile(path.join(workspaceDirFor(cacheDir, refreshed.root), "text.bin")));
    const fresh = serializeText(await buildIndex(repo, { cacheDir: path.join(dir, "cache2") })).bytes;
    expect(published.equals(fresh)).toBe(true);
    const loaded = (await loadIndex(repo, { cacheDir }))!;
    expect(loaded.files.get("src/app.ts")!.text).toBe(refreshed.files.get("src/app.ts")!.text);
  });
});
