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

// Once armed, retargets the parent as soon as the next check of the cache directory settles, and restores it as the
// check after that one begins, so neither check sees the retarget, only what runs between them.
function retargetedBetweenTheNextChecks(cacheDir: string, parent: string, elsewhere: string): { arm: () => void; restored: () => boolean } {
  const stat = vi.mocked(fs.stat).getMockImplementation() as (...args: unknown[]) => Promise<unknown>;
  let state: "idle" | "armed" | "retargeted" | "restored" = "idle";
  vi.spyOn(fs, "stat").mockImplementation((async (...args: unknown[]) => {
    if (args[0] === cacheDir && state === "retargeted") {
      await restore(parent);
      state = "restored";
    }
    const settled = await stat(...args).then((value) => ({ value }), (error: unknown) => ({ error }));
    if (args[0] === cacheDir && state === "armed") {
      await retarget(parent, elsewhere);
      state = "retargeted";
    }
    if ("error" in settled) throw settled.error;
    return settled.value;
  }) as never);
  return { arm: () => { state = "armed"; }, restored: () => state === "restored" };
}

// Every entry below dir with its kind, and each file's bytes.
async function contents(dir: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    found[path.relative(dir, full)] = entry.isFile() ? `file:${(await fs.readFile(full)).toString("base64")}` : entry.isDirectory() ? "dir" : "other";
  }
  return found;
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
    // The run's anchor stays behind, empty, since the run ended with the cache path naming another directory.
    const left = (await fs.readdir(path.join(`${parent}-saved`, "cache"))).sort();
    expect(left).toEqual([expect.stringMatching(/^\.osnova-bound-[0-9a-f-]{36}$/), "entry"]);
    expect(await fs.readdir(path.join(`${parent}-saved`, "cache", left[0] ?? ""))).toEqual([]);
  });

  it("gives each call the result and error it gives outside a run", async () => {
    const temporary = await temporaryDir();
    const cacheDir = path.join(temporary, "cache");
    const identity = await ensureCacheDir(cacheDir);
    const missing = path.join(cacheDir, "missing");
    const settle = async (call: Promise<unknown>): Promise<unknown> => await call.then((value) => ({ value }), (error: unknown) => {
      const failure = error as NodeJS.ErrnoException;
      return { code: failure.code, path: failure.path, named: failure.message.includes(".osnova-bound-") };
    });
    const outcomes = await withBoundCacheDir(cacheDir, identity, async () => ({
      created: await settle(cacheFs.mkdir(path.join(cacheDir, "a", "b", "c"), { recursive: true })),
      again: await settle(cacheFs.mkdir(path.join(cacheDir, "a", "b", "c"), { recursive: true })),
      root: await settle(cacheFs.mkdir(cacheDir, { recursive: true })),
      file: await settle(cacheFs.writeFile(path.join(cacheDir, "a", "file"), "x", { flag: "wx" })),
      exclusive: await settle(cacheFs.writeFile(path.join(cacheDir, "a", "file"), "x", { flag: "wx" })),
      overFile: await settle(cacheFs.mkdir(path.join(cacheDir, "a", "file"), { recursive: true })),
      underFile: await settle(cacheFs.mkdir(path.join(cacheDir, "a", "file", "d"), { recursive: true })),
      single: await settle(cacheFs.mkdir(path.join(missing, "d"))),
      orphan: await settle(cacheFs.writeFile(path.join(missing, "f"), "x")),
      forced: await settle(cacheFs.rm(missing, { force: true })),
      forcedTree: await settle(cacheFs.rm(missing, { recursive: true, force: true })),
      unforced: await settle(cacheFs.rm(missing)),
      unforcedTree: await settle(cacheFs.rm(missing, { recursive: true })),
      directory: await settle(cacheFs.rm(path.join(cacheDir, "a"))),
      unlinked: await settle(cacheFs.unlink(missing)),
      removed: await settle(cacheFs.rmdir(missing)),
      renamed: await settle(cacheFs.rename(missing, path.join(cacheDir, "elsewhere"))),
      copied: await settle(cacheFs.copyFile(missing, path.join(cacheDir, "copy"))),
      read: await settle(cacheFs.readFile(missing)),
      tree: await settle(cacheFs.rm(path.join(cacheDir, "a"), { recursive: true })),
    }));
    const enoent = (target: string): unknown => ({ code: "ENOENT", path: target, named: false });
    expect(outcomes).toEqual({
      created: { value: path.join(cacheDir, "a") },
      again: { value: undefined },
      root: { value: undefined },
      file: { value: undefined },
      exclusive: { code: "EEXIST", path: path.join(cacheDir, "a", "file"), named: false },
      overFile: { code: "EEXIST", path: path.join(cacheDir, "a", "file"), named: false },
      underFile: { code: "ENOTDIR", path: path.join(cacheDir, "a", "file", "d"), named: false },
      single: enoent(path.join(missing, "d")),
      orphan: enoent(path.join(missing, "f")),
      forced: { value: undefined },
      forcedTree: { value: undefined },
      unforced: enoent(missing),
      unforcedTree: enoent(missing),
      directory: { code: "ERR_FS_EISDIR", path: path.join(cacheDir, "a"), named: false },
      unlinked: enoent(missing),
      removed: enoent(missing),
      renamed: enoent(missing),
      copied: enoent(missing),
      read: enoent(missing),
      tree: { value: undefined },
    });
    expect(await fs.readdir(cacheDir)).toEqual([]);
  });

  it("leaves no anchor behind in a cache directory left as it was", async () => {
    const temporary = await temporaryDir();
    const cacheDir = path.join(temporary, "cache");
    const identity = await ensureCacheDir(cacheDir);
    await withBoundCacheDir(cacheDir, identity, async () => {
      await cacheFs.mkdir(path.join(cacheDir, "tree", "branch"), { recursive: true });
      await cacheFs.writeFile(path.join(cacheDir, "tree", "branch", "leaf"), "kept");
      await cacheFs.rm(path.join(cacheDir, "tree"), { recursive: true });
    });
    expect(await fs.readdir(cacheDir)).toEqual([]);
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

  // p/cache and q/cache hold the same names, so a change sent into q/cache finds what it would change in p/cache.
  async function twinCaches(): Promise<{ parent: string; elsewhere: string; cacheDir: string; otherCacheDir: string }> {
    const temporary = await temporaryDir();
    const parent = path.join(temporary, "p");
    const elsewhere = path.join(temporary, "q");
    for (const [dir, text] of [[path.join(parent, "cache"), "p"], [path.join(elsewhere, "cache"), "q"]] as const) {
      await fs.mkdir(path.join(dir, "entry"), { recursive: true });
      await fs.mkdir(path.join(dir, "empty"));
      await fs.mkdir(path.join(dir, "tree", "branch"), { recursive: true });
      await fs.writeFile(path.join(dir, "entry", "file"), text);
      await fs.writeFile(path.join(dir, "tree", "branch", "leaf"), text);
    }
    return { parent, elsewhere, cacheDir: path.join(parent, "cache"), otherCacheDir: path.join(elsewhere, "cache") };
  }

  const changes: ReadonlyArray<readonly [string, (cacheDir: string) => Promise<unknown>]> = [
    ["writeFile", async (cacheDir) => await cacheFs.writeFile(path.join(cacheDir, "entry", "new"), "x", { flag: "wx" })],
    ["writeFile over a file", async (cacheDir) => await cacheFs.writeFile(path.join(cacheDir, "entry", "file"), "x")],
    ["mkdir", async (cacheDir) => await cacheFs.mkdir(path.join(cacheDir, "entry", "made"))],
    ["copyFile", async (cacheDir) => await cacheFs.copyFile(path.join(cacheDir, "entry", "file"), path.join(cacheDir, "entry", "copy"))],
    ["rename", async (cacheDir) => await cacheFs.rename(path.join(cacheDir, "entry", "file"), path.join(cacheDir, "entry", "moved"))],
    ["rm", async (cacheDir) => await cacheFs.rm(path.join(cacheDir, "entry", "file"), { force: true })],
    ["recursive rm", async (cacheDir) => await cacheFs.rm(path.join(cacheDir, "tree"), { recursive: true, force: true })],
    ["rmdir", async (cacheDir) => await cacheFs.rmdir(path.join(cacheDir, "empty"))],
    ["unlink", async (cacheDir) => await cacheFs.unlink(path.join(cacheDir, "entry", "file"))],
  ];

  it.each(changes)("changes nothing in either cache, and fails, when a parent is retargeted after the check before a %s and restored before the check after it", async (_name, change) => {
    const { parent, elsewhere, cacheDir, otherCacheDir } = await twinCaches();
    const identity = await ensureCacheDir(cacheDir);
    const ours = await contents(cacheDir);
    const others = await contents(otherCacheDir);
    const window = retargetedBetweenTheNextChecks(cacheDir, parent, elsewhere);
    const outcome = await withBoundCacheDir(cacheDir, identity, async () => {
      window.arm();
      return await change(cacheDir).then(() => "changed", (error: unknown) => error);
    });
    vi.restoreAllMocks();
    await restore(parent);
    expect(window.restored()).toBe(true);
    expect(outcome).toMatchObject({ diagnostic: { phase: "cache", path: cacheDir, code: "cache-changing" } });
    expect(await contents(otherCacheDir)).toEqual(others);
    expect(await contents(cacheDir)).toEqual(ours);
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

  // As sharedParent, and q/cache also holds entries for p/root and p/root2, built while q stood at p, so a change of
  // either entry sent into q/cache finds the files it would change there.
  async function sharedEntries(): Promise<{ parent: string; elsewhere: string; root: string; cacheDir: string; otherCacheDir: string; key: string; olderKey: string }> {
    const shared = await sharedParent();
    const { parent, elsewhere, root, cacheDir } = shared;
    const older = path.join(parent, "root2");
    await fs.mkdir(older);
    await fs.mkdir(path.join(elsewhere, "root2"));
    await fs.writeFile(path.join(older, "b.ts"), "export function olderInP() { return 4; }\n");
    await fs.writeFile(path.join(elsewhere, "root2", "b.ts"), "export function olderInQ() { return 5; }\n");
    await refreshWorkspaceWitnessed(older, { cacheDir });
    await fs.rename(parent, `${parent}-saved`);
    await fs.rename(elsewhere, parent);
    await fs.rm(path.join(root, "a.ts"));
    await fs.writeFile(path.join(root, "a.ts"), "export function onlyInQ() { return 2; }\n");
    expect(names((await refreshWorkspaceWitnessed(root, { cacheDir })).index)).toContain("onlyInQ");
    expect(names((await refreshWorkspaceWitnessed(older, { cacheDir })).index)).toContain("olderInQ");
    await fs.rename(parent, elsewhere);
    await fs.rename(`${parent}-saved`, parent);
    return { ...shared, olderKey: path.basename(workspaceDirFor(cacheDir, older)) };
  }

  // Retargets the parent inside the first call the condition accepts, after the check before it, and restores it before
  // the call returns, so the check after it sees the cache directory as it was.
  function retargetedDuring(name: "writeFile" | "rm", parent: string, elsewhere: string, accept: (target: string) => boolean): () => boolean {
    const original = fs[name].bind(fs) as (...args: unknown[]) => Promise<unknown>;
    let done = false;
    vi.spyOn(fs, name).mockImplementation((async (...args: unknown[]) => {
      if (done || !accept(String(args[0]))) return await original(...args);
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

  it("fails the refresh, and changes nothing in the retargeted cache, when a parent is retargeted during the write of an artifact it publishes", async () => {
    const { parent, elsewhere, root, cacheDir, otherCacheDir, key } = await sharedEntries();
    const others = await contents(otherCacheDir);
    const retargeted = retargetedDuring("writeFile", parent, elsewhere, (target) =>
      path.basename(path.dirname(target)) === key && path.basename(target).startsWith("index.json.tmp-"));
    const outcome = await refreshWorkspaceWitnessed(root, { cacheDir }).then((answer) => answer, (error: unknown) => error);
    vi.restoreAllMocks();
    await restore(parent);
    expect(retargeted()).toBe(true);
    expect(outcome).toMatchObject({ diagnostic: { phase: "cache", path: cacheDir, code: "cache-changing" } });
    expect(await contents(otherCacheDir)).toEqual(others);
    expect(names((await refreshWorkspaceWitnessed(root, { cacheDir })).index)).toEqual(expect.arrayContaining(["onlyInP", "addedInP"]));
  });

  it("fails the refresh, and deletes nothing in the retargeted cache, when a parent is retargeted during the deletion of an evicted entry", async () => {
    const { parent, elsewhere, root, cacheDir, otherCacheDir, olderKey } = await sharedEntries();
    const others = await contents(otherCacheDir);
    const retargeted = retargetedDuring("rm", parent, elsewhere, (target) =>
      path.basename(path.dirname(target)) === olderKey && path.basename(target) === "index.json");
    const outcome = await refreshWorkspaceWitnessed(root, { cacheDir, maxWorkspaces: 1 }).then((answer) => answer, (error: unknown) => error);
    vi.restoreAllMocks();
    await restore(parent);
    expect(retargeted()).toBe(true);
    expect(outcome).toMatchObject({ diagnostic: { phase: "cache", path: cacheDir, code: "cache-changing" } });
    expect(await contents(otherCacheDir)).toEqual(others);
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
