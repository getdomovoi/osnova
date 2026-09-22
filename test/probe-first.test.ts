import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index/build.js";
import { refreshWorkspace, indexGeneration, loadIndex } from "../src/api.js";
import { workspaceDirFor } from "../src/cache/cache.js";
import { scanFiles } from "../src/index/scan.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-repo");
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

describe("probe-first refresh", () => {
  it("opens no section file on a clean reuseMemory refresh", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-probe-")); dirs.push(dir);
    const cacheDir = path.join(dir, "cache");
    await buildIndex(FIXTURE, { cacheDir });
    const first = await refreshWorkspace(FIXTURE, { cacheDir, reuseMemory: true });
    const opened: string[] = [];
    const readFile = fs.readFile;
    vi.spyOn(fs, "readFile").mockImplementation(async (p, ...rest) => { opened.push(String(p)); return readFile(p, ...rest as [never]); });
    const second = await refreshWorkspace(FIXTURE, { cacheDir, reuseMemory: true });
    expect(second).toBe(first);
    expect(opened.filter((p) => /index\.json|edges\.json|text\.bin/.test(p))).toEqual([]);
    expect(indexGeneration(second)).toBe(indexGeneration(first));
  });

  it("refuses memory reuse when the probed digest is not the cached generation", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-probe-sha-")); dirs.push(dir);
    const repo = path.join(dir, "repo"); const cacheDir = path.join(dir, "cache");
    await fs.cp(FIXTURE, repo, { recursive: true });
    const built = await buildIndex(repo, { cacheDir });
    const shaPath = path.join(workspaceDirFor(cacheDir, built.root), "index.sha");
    const first = await refreshWorkspace(repo, { cacheDir, reuseMemory: true });
    await fs.writeFile(shaPath, `${"0".repeat(64)}\n`);
    const second = await refreshWorkspace(repo, { cacheDir, reuseMemory: true });
    expect(second).not.toBe(first);
    expect((await fs.readFile(shaPath, "utf8")).trim()).toBe(indexGeneration(built));
    await expect(loadIndex(repo, { cacheDir })).resolves.toBeDefined();
  });

  it("returns undefined for a checksum-less format 8 cache and rejects a checksum-less current-format cache", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-probe-legacy-")); dirs.push(dir);
    const repo = path.join(dir, "repo"); const cacheDir = path.join(dir, "cache");
    await fs.cp(FIXTURE, repo, { recursive: true });
    const built = await buildIndex(repo, { cacheDir });
    const ws = workspaceDirFor(cacheDir, built.root);
    const core = JSON.parse((await fs.readFile(path.join(ws, "index.json"))).toString("utf8")) as Record<string, unknown>;
    await fs.rm(path.join(ws, "index.sha"));
    await expect(loadIndex(repo, { cacheDir })).rejects.toMatchObject({ diagnostic: { code: "cache-read-failed" } });
    await fs.writeFile(path.join(ws, "index.json"), JSON.stringify({ ...core, formatVersion: 8 }));
    await expect(loadIndex(repo, { cacheDir })).resolves.toBeUndefined();
    await fs.writeFile(path.join(ws, "index.json"), "{not json");
    await expect(loadIndex(repo, { cacheDir })).rejects.toMatchObject({ diagnostic: { code: "cache-read-failed" } });
    for (const malformed of ['{"formatVersion":8,', '{"metadata":{"formatVersion":8},"formatVersion":12}', '{"formatVersion":8.9}']) {
      await fs.writeFile(path.join(ws, "index.json"), malformed);
      await expect(loadIndex(repo, { cacheDir })).rejects.toMatchObject({ diagnostic: { code: "cache-read-failed" } });
    }
    await fs.writeFile(path.join(ws, "index.json"), JSON.stringify({ padding: "x".repeat(600), formatVersion: 8 }));
    await expect(loadIndex(repo, { cacheDir })).resolves.toBeUndefined();
  });

  it("scans before loading the core on a cold refresh", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-probe-")); dirs.push(dir);
    const cacheDir = path.join(dir, "cache");
    await buildIndex(FIXTURE, { cacheDir });
    const order: string[] = [];
    const readdir = fs.readdir; const readFile = fs.readFile;
    vi.spyOn(fs, "readdir").mockImplementation((async (p: Parameters<typeof fs.readdir>[0], ...rest: unknown[]) => { order.push("scan"); return readdir(p, ...rest as [never]); }) as typeof fs.readdir);
    vi.spyOn(fs, "readFile").mockImplementation(async (p, ...rest) => { if (String(p).endsWith("index.json")) order.push("core"); return readFile(p, ...rest as [never]); });
    await refreshWorkspace(FIXTURE, { cacheDir });
    expect(order.indexOf("scan")).toBeLessThan(order.indexOf("core"));
  });

  it("dirty refresh walks the tree once more than a clean refresh, not twice more", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-probe-tree-")); dirs.push(dir);
    const root = path.join(dir, "root");
    const cacheDir = path.join(dir, "cache");
    await fs.mkdir(path.join(root, "sub"), { recursive: true });
    await fs.writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
    await fs.writeFile(path.join(root, "sub", "b.ts"), "export const b = 1;\n");
    await buildIndex(root, { cacheDir });

    const readdir = fs.readdir;
    async function countTreeReaddirs(fn: () => Promise<unknown>): Promise<number> {
      let count = 0;
      const spy = vi.spyOn(fs, "readdir").mockImplementation((async (p: Parameters<typeof fs.readdir>[0], ...rest: unknown[]) => {
        if (String(p).startsWith(root)) count += 1;
        return readdir(p, ...rest as [never]);
      }) as typeof fs.readdir);
      await fn();
      spy.mockRestore();
      return count;
    }

    const walkCalls = await countTreeReaddirs(() => scanFiles(root));
    const cleanCalls = await countTreeReaddirs(() => refreshWorkspace(root, { cacheDir }));
    expect(cleanCalls).toBe(walkCalls);

    await fs.appendFile(path.join(root, "sub", "b.ts"), "export const c = 2;\n");
    const dirtyCalls = await countTreeReaddirs(() => refreshWorkspace(root, { cacheDir }));
    expect(dirtyCalls).toBe(cleanCalls + walkCalls);
  });
});
