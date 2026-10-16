import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { refreshWorkspaceWitnessed } from "../src/api.js";
import { cacheFs, ensureCacheDir, withBoundCacheDir } from "../src/cache/bound.js";
import { workspaceDirFor } from "../src/cache/cache.js";

// Every test here runs where a cache directory cannot be bound to a descriptor. Platforms without /proc/self/fd are such
// a place already; elsewhere the probe of /proc/self/fd fails, as it does on a restricted Linux.
const temporaries: string[] = [];
let probed = false;
beforeEach(() => {
  const stat = fs.stat.bind(fs) as (...args: unknown[]) => Promise<unknown>;
  vi.spyOn(fs, "stat").mockImplementation((async (...args: unknown[]) => {
    if (String(args[0]).startsWith("/proc/self/fd/")) {
      probed = true;
      throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${String(args[0])}'`), { code: "ENOENT" });
    }
    return await stat(...args);
  }) as never);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of temporaries.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function temporaryDir(): Promise<string> {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "osnova-cache-fallback-")));
  temporaries.push(temporary);
  return temporary;
}

async function retarget(parent: string, elsewhere: string): Promise<void> {
  await fs.rename(parent, `${parent}-saved`);
  await fs.symlink(elsewhere, parent, "dir");
}

async function restore(parent: string): Promise<void> {
  if (!(await fs.lstat(parent)).isSymbolicLink()) return;
  await fs.unlink(parent);
  await fs.rename(`${parent}-saved`, parent);
}

// Runs after, once, as soon as fs.stat of the given path settles and the condition accepts it.
function afterStat(target: string, accept: () => boolean, after: () => Promise<void>): void {
  const stat = vi.mocked(fs.stat).getMockImplementation() as (...args: unknown[]) => Promise<unknown>;
  let pending = true;
  vi.spyOn(fs, "stat").mockImplementation((async (...args: unknown[]) => {
    const settled = await stat(...args).then((value) => ({ value }), (error: unknown) => ({ error }));
    if (pending && path.resolve(String(args[0])) === target && accept()) {
      pending = false;
      await after();
    }
    if ("error" in settled) throw settled.error;
    return settled.value;
  }) as never);
}

describe("withBoundCacheDir where the cache directory cannot be bound", () => {
  it("refuses a cache write once a parent of the cache is retargeted", async () => {
    const temporary = await temporaryDir();
    const parent = path.join(temporary, "p");
    const elsewhere = path.join(temporary, "q");
    const cacheDir = path.join(parent, "cache");
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.mkdir(path.join(elsewhere, "cache"), { recursive: true });
    const identity = await ensureCacheDir(cacheDir);
    const outcome = await withBoundCacheDir(cacheDir, identity, async () => {
      await cacheFs.mkdir(path.join(cacheDir, "entry"));
      await retarget(parent, elsewhere);
      return await cacheFs.writeFile(path.join(cacheDir, "file"), "unbound").then(() => "written", (error: unknown) => error);
    });
    expect(probed).toBe(process.platform === "linux");
    expect(outcome).toMatchObject({ diagnostic: { phase: "cache", path: cacheDir, code: "cache-changing" } });
    expect(await fs.readdir(path.join(elsewhere, "cache"))).toEqual([]);
    expect(await fs.readdir(path.join(`${parent}-saved`, "cache"))).toEqual(["entry"]);
  });

  it("fails a cache write during which a parent of the cache is retargeted, and refuses the next", async () => {
    const temporary = await temporaryDir();
    const parent = path.join(temporary, "p");
    const elsewhere = path.join(temporary, "q");
    const cacheDir = path.join(parent, "cache");
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.mkdir(path.join(elsewhere, "cache"), { recursive: true });
    const identity = await ensureCacheDir(cacheDir);
    const writeFile = fs.writeFile.bind(fs) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(fs, "writeFile").mockImplementationOnce((async (...args: unknown[]) => {
      await retarget(parent, elsewhere);
      return await writeFile(...args);
    }) as never);
    const outcome = await withBoundCacheDir(cacheDir, identity, async () => {
      const written = await cacheFs.writeFile(path.join(cacheDir, "file.tmp"), "unbound").then(() => "written", (error: unknown) => error);
      const renamed = await cacheFs.rename(path.join(cacheDir, "file.tmp"), path.join(cacheDir, "file")).then(() => "renamed", (error: unknown) => error);
      return { written, renamed };
    });
    expect(outcome.written).toMatchObject({ diagnostic: { code: "cache-changing" } });
    expect(outcome.renamed).toMatchObject({ diagnostic: { code: "cache-changing" } });
    await expect(fs.access(path.join(elsewhere, "cache", "file"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes as before to a cache directory left as it was", async () => {
    const temporary = await temporaryDir();
    const cacheDir = path.join(temporary, "cache");
    const identity = await ensureCacheDir(cacheDir);
    await withBoundCacheDir(cacheDir, identity, async () => {
      await cacheFs.mkdir(path.join(cacheDir, "entry"), { recursive: true });
      await cacheFs.writeFile(path.join(cacheDir, "entry", "file.tmp"), "kept");
      await cacheFs.rename(path.join(cacheDir, "entry", "file.tmp"), path.join(cacheDir, "entry", "file"));
    });
    expect(await fs.readFile(path.join(cacheDir, "entry", "file"), "utf8")).toBe("kept");
  });
});

describe("refreshWorkspaceWitnessed where the cache directory cannot be bound", () => {
  // The cache lies beneath the same parent as the root, and q holds a root and a cache of the same names.
  async function sharedParent(): Promise<{ parent: string; elsewhere: string; root: string; cacheDir: string; otherCacheDir: string; key: string }> {
    const temporary = await temporaryDir();
    const parent = path.join(temporary, "p");
    const elsewhere = path.join(temporary, "q");
    const root = path.join(parent, "root");
    const other = path.join(elsewhere, "root");
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(root, "a.ts"), "export function onlyInP() { return 1; }\n");
    await fs.writeFile(path.join(other, "a.ts"), "export function onlyInQ() { return 2; }\n");
    const cacheDir = path.join(parent, "cache");
    const otherCacheDir = path.join(elsewhere, "cache");
    expect(names((await refreshWorkspaceWitnessed(root, { cacheDir })).index)).toContain("onlyInP");
    expect(names((await refreshWorkspaceWitnessed(other, { cacheDir: otherCacheDir })).index)).toContain("onlyInQ");
    await fs.appendFile(path.join(root, "a.ts"), "export function addedInP() { return 3; }\n");
    return { parent, elsewhere, root, cacheDir, otherCacheDir, key: path.basename(workspaceDirFor(cacheDir, root)) };
  }

  // Once the parent has been retargeted, the first check of the cache directory fails the refresh, and the parent is
  // restored straight after it, so no later check of the root sees the retarget.
  function restoredAfterTheNextCheck(cacheDir: string, parent: string, retargeted: () => boolean): void {
    afterStat(cacheDir, retargeted, () => restore(parent));
  }

  it("writes nothing into the retargeted cache when a parent is retargeted after the root check before the verification is published", async () => {
    const { parent, elsewhere, root, cacheDir, otherCacheDir } = await sharedParent();
    const otherEntries = (await fs.readdir(otherCacheDir)).sort();
    let published = false;
    let retargeted = false;
    const rename = fs.rename.bind(fs) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(fs, "rename").mockImplementation((async (...args: unknown[]) => {
      const result = await rename(...args);
      if (path.basename(String(args[1])) === "index.sha") published = true;
      return result;
    }) as never);
    afterStat(root, () => published, async () => {
      await retarget(parent, elsewhere);
      retargeted = true;
    });
    restoredAfterTheNextCheck(cacheDir, parent, () => retargeted);
    const outcome = await refreshWorkspaceWitnessed(root, { cacheDir }).then((answer) => answer, (error: unknown) => error);
    vi.restoreAllMocks();
    await restore(parent);
    expect(retargeted).toBe(true);
    expect(outcome).toMatchObject({ diagnostic: { phase: "cache", path: cacheDir, code: "cache-changing" } });
    expect((await fs.readdir(otherCacheDir)).sort()).toEqual(otherEntries);
    expect(names((await refreshWorkspaceWitnessed(root, { cacheDir })).index)).toEqual(expect.arrayContaining(["onlyInP", "addedInP"]));
  });

  // Nothing but a descriptor stops the one call already resolving its path when the parent is retargeted. The check
  // after it fails the refresh, so nothing more is written and nothing is published there.
  it("fails the refresh, and publishes nothing into the retargeted cache, when a parent is retargeted during a cache write", async () => {
    const { parent, elsewhere, root, cacheDir, otherCacheDir, key } = await sharedParent();
    let published = false;
    let retargeted = false;
    const rename = fs.rename.bind(fs) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(fs, "rename").mockImplementation((async (...args: unknown[]) => {
      const result = await rename(...args);
      if (path.basename(String(args[1])) === "index.sha") published = true;
      return result;
    }) as never);
    const mkdir = fs.mkdir.bind(fs) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(fs, "mkdir").mockImplementation((async (...args: unknown[]) => {
      if (published && !retargeted && path.basename(String(args[0])) === key) {
        await retarget(parent, elsewhere);
        retargeted = true;
      }
      return await mkdir(...args);
    }) as never);
    restoredAfterTheNextCheck(cacheDir, parent, () => retargeted);
    const outcome = await refreshWorkspaceWitnessed(root, { cacheDir }).then((answer) => answer, (error: unknown) => error);
    vi.restoreAllMocks();
    await restore(parent);
    expect(retargeted).toBe(true);
    expect(outcome).toMatchObject({ diagnostic: { phase: "cache", path: cacheDir, code: "cache-changing" } });
    expect(await fs.readdir(path.join(otherCacheDir, key)).catch(() => [])).toEqual([]);
    expect(names((await refreshWorkspaceWitnessed(root, { cacheDir })).index)).toEqual(expect.arrayContaining(["onlyInP", "addedInP"]));
  });
});

const names = (index: { symbols: ReadonlyMap<string, { name: string }> }): string[] => [...index.symbols.values()].map((symbol) => symbol.name);
