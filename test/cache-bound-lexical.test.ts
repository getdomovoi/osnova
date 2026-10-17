import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { refreshWorkspaceWitnessed } from "../src/api.js";
import { cacheFs, ensureCacheDir, withBoundCacheDir } from "../src/cache/bound.js";

// Every test here runs where no descriptor can bind a cache directory and .. drops the name before it, as Windows
// resolves a path, so no anchor can bind it either. On other platforms a stat of a path through .. is resolved by name,
// which is what the probe for an anchor sees on Windows.
const temporaries: string[] = [];
beforeEach(() => {
  const stat = fs.stat.bind(fs) as (...args: unknown[]) => Promise<unknown>;
  vi.spyOn(fs, "stat").mockImplementation((async (...args: unknown[]) => {
    const target = String(args[0]);
    if (target.startsWith("/proc/self/fd/")) throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${target}'`), { code: "ENOENT" });
    return await stat(target.split(/[/\\]/).includes("..") ? path.resolve(target) : target, ...args.slice(1));
  }) as never);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of temporaries.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function temporaryDir(): Promise<string> {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "osnova-cache-lexical-")));
  temporaries.push(temporary);
  return temporary;
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

// Retargets the parent inside the first call of name and restores it before the call returns, so the checks before and
// after it both see the cache directory as it was.
function retargetedDuring(name: "rename" | "rm", parent: string, elsewhere: string): () => boolean {
  const original = fs[name].bind(fs) as (...args: unknown[]) => Promise<unknown>;
  let done = false;
  vi.spyOn(fs, name).mockImplementation((async (...args: unknown[]) => {
    if (done) return await original(...args);
    done = true;
    await retarget(parent, elsewhere);
    try {
      return await original(...args);
    } finally {
      await restore(parent);
    }
  }) as never);
  return () => done;
}

const refused = (cacheDir: string): object => ({ diagnostic: { phase: "cache", path: cacheDir, code: "cache-unbindable" } });

describe("withBoundCacheDir where .. resolves by name", () => {
  const publications: ReadonlyArray<readonly [string, "rename" | "rm", (cacheDir: string) => Promise<unknown>]> = [
    ["the publication of an artifact", "rename", async (cacheDir) => await cacheFs.rename(path.join(cacheDir, "entry", "file.tmp"), path.join(cacheDir, "entry", "file"))],
    ["the deletion of an entry", "rm", async (cacheDir) => await cacheFs.rm(path.join(cacheDir, "tree"), { recursive: true, force: true })],
  ];

  it.each(publications)("refuses %s before it changes anything, so a parent retargeted during it changes neither cache", async (_name, call, change) => {
    const { parent, elsewhere, cacheDir, otherCacheDir } = await twinCaches();
    const identity = await ensureCacheDir(cacheDir);
    const ours = await contents(cacheDir);
    const others = await contents(otherCacheDir);
    const retargeted = retargetedDuring(call, parent, elsewhere);
    const outcome = await withBoundCacheDir(cacheDir, identity, async () => await change(cacheDir).then(() => "changed", (error: unknown) => error));
    vi.restoreAllMocks();
    await restore(parent);
    expect(await contents(otherCacheDir)).toEqual(others);
    expect(await contents(cacheDir)).toEqual(ours);
    expect(outcome).toMatchObject(refused(cacheDir));
    expect(retargeted()).toBe(false);
  });

  it("refuses every change within the cache directory, and reads it by path", async () => {
    const { cacheDir } = await twinCaches();
    const identity = await ensureCacheDir(cacheDir);
    const ours = await contents(cacheDir);
    const settle = async (call: Promise<unknown>): Promise<unknown> => await call.then(() => "changed", (error: unknown) => error);
    const outcomes = await withBoundCacheDir(cacheDir, identity, async () => [
      await settle(cacheFs.writeFile(path.join(cacheDir, "entry", "new"), "x", { flag: "wx" })),
      await settle(cacheFs.mkdir(path.join(cacheDir, "made"))),
      await settle(cacheFs.mkdir(path.join(cacheDir, "made", "deeper"), { recursive: true })),
      await settle(cacheFs.copyFile(path.join(cacheDir, "entry", "file"), path.join(cacheDir, "entry", "copy"))),
      await settle(cacheFs.rename(path.join(cacheDir, "entry", "file"), path.join(cacheDir, "entry", "moved"))),
      await settle(cacheFs.rm(path.join(cacheDir, "entry", "file"), { force: true })),
      await settle(cacheFs.rmdir(path.join(cacheDir, "tree", "branch"))),
      await settle(cacheFs.unlink(path.join(cacheDir, "entry", "file"))),
      await cacheFs.readFile(path.join(cacheDir, "entry", "file"), "utf8"),
    ]);
    expect(outcomes).toEqual([...Array.from({ length: 8 }, () => expect.objectContaining(refused(cacheDir))), "p"]);
    expect(await contents(cacheDir)).toEqual(ours);
  });

  it("changes a path outside the cache directory as given", async () => {
    const temporary = await temporaryDir();
    const cacheDir = path.join(temporary, "cache");
    const identity = await ensureCacheDir(cacheDir);
    await withBoundCacheDir(cacheDir, identity, async () => await cacheFs.writeFile(path.join(temporary, "beside"), "x"));
    expect(await fs.readFile(path.join(temporary, "beside"), "utf8")).toBe("x");
  });
});

describe("refreshWorkspaceWitnessed where .. resolves by name", () => {
  it("fails before it writes anything into the cache directory", async () => {
    const temporary = await temporaryDir();
    const root = path.join(temporary, "root");
    const cacheDir = path.join(temporary, "cache");
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "a.ts"), "export function refused() { return 1; }\n");
    const outcome = await refreshWorkspaceWitnessed(root, { cacheDir }).then((answer) => answer, (error: unknown) => error);
    expect(outcome).toMatchObject(refused(cacheDir));
    expect(await fs.readdir(cacheDir)).toEqual([]);
  });
});
