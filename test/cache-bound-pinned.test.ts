import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { refreshWorkspaceWitnessed } from "../src/api.js";
import { cacheFs, ensureCacheDir, withBoundCacheDir } from "../src/cache/bound.js";

// Windows resolves .. by name and has no /proc/self/fd, so neither a descriptor nor an anchor binds a cache directory
// there. It does refuse to rename or remove a directory while a file inside it is open, so a file held open in the
// cache directory keeps the cache directory and every directory above it in place. Each test here runs as if on
// Windows: elsewhere a stat through /proc/self/fd fails and a stat through .. is resolved by name. Only Windows itself
// keeps the directories in place, so the tests of what a retarget meets run there alone.
const windows = process.platform === "win32";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const temporaries: string[] = [];
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  const stat = fs.stat.bind(fs) as (...args: unknown[]) => Promise<unknown>;
  vi.spyOn(fs, "stat").mockImplementation((async (...args: unknown[]) => {
    const target = String(args[0]);
    if (target.startsWith("/proc/self/fd/")) throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${target}'`), { code: "ENOENT" });
    return await stat(target.split(/[/\\]/).includes("..") ? path.resolve(target) : target, ...args.slice(1));
  }) as never);
});
afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
  for (const dir of temporaries.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function temporaryDir(): Promise<string> {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "osnova-cache-pinned-")));
  temporaries.push(temporary);
  return temporary;
}

async function contents(dir: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    found[path.relative(dir, full)] = entry.isFile() ? `file:${(await fs.readFile(full)).toString("base64")}` : entry.isDirectory() ? "dir" : "other";
  }
  return found;
}

// p/cache and q/cache hold the same names, so a change sent into q/cache finds what it would change in p/cache.
async function twinCaches(): Promise<{ parent: string; elsewhere: string; cacheDir: string; otherCacheDir: string }> {
  const temporary = await temporaryDir();
  const parent = path.join(temporary, "p");
  const elsewhere = path.join(temporary, "q");
  for (const [dir, text] of [[path.join(parent, "cache"), "p"], [path.join(elsewhere, "cache"), "q"]] as const) {
    await fs.mkdir(path.join(dir, "entry"), { recursive: true });
    await fs.mkdir(path.join(dir, "tree", "branch"), { recursive: true });
    await fs.writeFile(path.join(dir, "entry", "file"), text);
    await fs.writeFile(path.join(dir, "entry", "file.tmp"), `${text} published`);
    await fs.writeFile(path.join(dir, "tree", "branch", "leaf"), text);
  }
  return { parent, elsewhere, cacheDir: path.join(parent, "cache"), otherCacheDir: path.join(elsewhere, "cache") };
}

async function retarget(parent: string, elsewhere: string): Promise<void> {
  await fs.rename(parent, `${parent}-saved`);
  await fs.symlink(elsewhere, parent, "junction");
}

async function restore(parent: string): Promise<void> {
  if (!(await fs.lstat(parent)).isSymbolicLink()) return;
  await fs.unlink(parent);
  await fs.rename(`${parent}-saved`, parent);
}

const pins = async (dir: string): Promise<string[]> => (await fs.readdir(dir)).filter((name) => name.startsWith(".osnova-bound-"));

describe("withBoundCacheDir where a file held open keeps the cache directory in place", () => {
  it("makes every change within the cache directory, reads it, and leaves nothing of its own behind", async () => {
    const { cacheDir, otherCacheDir } = await twinCaches();
    const identity = await ensureCacheDir(cacheDir);
    const others = await contents(otherCacheDir);
    const read = await withBoundCacheDir(cacheDir, identity, async () => {
      await cacheFs.writeFile(path.join(cacheDir, "entry", "new"), "x", { flag: "wx" });
      await cacheFs.mkdir(path.join(cacheDir, "made", "deeper"), { recursive: true });
      await cacheFs.copyFile(path.join(cacheDir, "entry", "file"), path.join(cacheDir, "entry", "copy"));
      await cacheFs.rename(path.join(cacheDir, "entry", "file.tmp"), path.join(cacheDir, "entry", "file"));
      await cacheFs.rm(path.join(cacheDir, "tree"), { recursive: true, force: true });
      await cacheFs.rmdir(path.join(cacheDir, "made", "deeper"));
      await cacheFs.unlink(path.join(cacheDir, "entry", "copy"));
      return await cacheFs.readFile(path.join(cacheDir, "entry", "file"), "utf8");
    });
    expect(read).toBe("p published");
    expect(await contents(cacheDir)).toEqual({ entry: "dir", [path.join("entry", "file")]: `file:${Buffer.from("p published").toString("base64")}`, [path.join("entry", "new")]: `file:${Buffer.from("x").toString("base64")}`, made: "dir" });
    expect(await contents(otherCacheDir)).toEqual(others);
  });

  it("holds a file open inside the cache directory for the whole run", async () => {
    const { cacheDir } = await twinCaches();
    const identity = await ensureCacheDir(cacheDir);
    const during = await withBoundCacheDir(cacheDir, identity, async () => {
      await cacheFs.writeFile(path.join(cacheDir, "entry", "new"), "x");
      return await pins(cacheDir);
    });
    expect(during).toHaveLength(1);
    expect(await pins(cacheDir)).toEqual([]);
  });

  it("fails with cache-changing before it changes anything when the cache path names another directory as the run begins", async () => {
    const { parent, elsewhere, cacheDir, otherCacheDir } = await twinCaches();
    const identity = await ensureCacheDir(cacheDir);
    await retarget(parent, elsewhere);
    const others = await contents(otherCacheDir);
    let ran = false;
    const outcome = await withBoundCacheDir(cacheDir, identity, async () => { ran = true; }).then(() => "ran", (error: unknown) => error);
    await restore(parent);
    expect(outcome).toMatchObject({ diagnostic: { phase: "cache", path: cacheDir, code: "cache-changing" } });
    expect(ran).toBe(false);
    expect(await contents(otherCacheDir)).toEqual(others);
    expect(await pins(cacheDir)).toEqual([]);
  });

  it("changes a path outside the cache directory as given", async () => {
    const temporary = await temporaryDir();
    const cacheDir = path.join(temporary, "cache");
    const identity = await ensureCacheDir(cacheDir);
    await withBoundCacheDir(cacheDir, identity, async () => await cacheFs.writeFile(path.join(temporary, "beside"), "x"));
    expect(await fs.readFile(path.join(temporary, "beside"), "utf8")).toBe("x");
  });
});

describe.runIf(windows)("withBoundCacheDir on Windows", () => {
  it("keeps the cache directory and its parent from being renamed while a run is bound", async () => {
    const { parent, cacheDir } = await twinCaches();
    const identity = await ensureCacheDir(cacheDir);
    const attempts = await withBoundCacheDir(cacheDir, identity, async () => await Promise.all([
      fs.rename(parent, `${parent}-saved`).then(() => "renamed", (error: unknown) => (error as NodeJS.ErrnoException).code),
      fs.rename(cacheDir, `${cacheDir}-saved`).then(() => "renamed", (error: unknown) => (error as NodeJS.ErrnoException).code),
    ]));
    for (const attempt of attempts) expect(["EPERM", "EACCES", "EBUSY"]).toContain(attempt);
    await fs.rename(parent, `${parent}-saved`);
    await fs.rename(`${parent}-saved`, parent);
  });

  it.each([
    ["the publication of an artifact", "rename", async (cacheDir: string) => await cacheFs.rename(path.join(cacheDir, "entry", "file.tmp"), path.join(cacheDir, "entry", "file"))],
    ["the deletion of an entry", "rm", async (cacheDir: string) => await cacheFs.rm(path.join(cacheDir, "tree"), { recursive: true, force: true })],
  ] as const)("keeps a parent from being retargeted during %s, so the other cache stays as it was", async (_name, call, change) => {
    const { parent, elsewhere, cacheDir, otherCacheDir } = await twinCaches();
    const identity = await ensureCacheDir(cacheDir);
    const others = await contents(otherCacheDir);
    const original = fs[call].bind(fs) as (...args: unknown[]) => Promise<unknown>;
    let refused: unknown;
    let done = false;
    vi.spyOn(fs, call).mockImplementation((async (...args: unknown[]) => {
      if (done) return await original(...args);
      done = true;
      await retarget(parent, elsewhere).catch((error: unknown) => { refused = (error as NodeJS.ErrnoException).code; });
      try {
        return await original(...args);
      } finally {
        await restore(parent);
      }
    }) as never);
    await withBoundCacheDir(cacheDir, identity, async () => await change(cacheDir));
    vi.restoreAllMocks();
    expect(["EPERM", "EACCES", "EBUSY"]).toContain(refused);
    expect(await contents(otherCacheDir)).toEqual(others);
  });

  it("refreshes a workspace and leaves no pin in the cache directory", async () => {
    Object.defineProperty(process, "platform", platform);
    vi.restoreAllMocks();
    const temporary = await temporaryDir();
    const root = path.join(temporary, "root");
    const cacheDir = path.join(temporary, "cache");
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "a.ts"), "export function pinned() { return 1; }\n");
    const { index } = await refreshWorkspaceWitnessed(root, { cacheDir });
    expect([...index.files.keys()]).toEqual(["a.ts"]);
    expect(await pins(cacheDir)).toEqual([]);
  });
});
