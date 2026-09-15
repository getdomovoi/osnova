import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index/build.js";
import { refreshWorkspace, indexGeneration } from "../src/api.js";

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
});
