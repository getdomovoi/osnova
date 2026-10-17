import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import nodeFs, { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { refreshWorkspaceWitnessed } from "../src/api.js";
import { cacheFs, ensureCacheDir, withBoundCacheDir } from "../src/cache/bound.js";
import { workspaceDirFor } from "../src/cache/cache.js";

// Every test here runs where a cache directory cannot be bound to a descriptor. Platforms without /proc/self/fd are such
// a place already; elsewhere the probe of /proc/self/fd fails, as it does on a restricted Linux. They need .. to resolve
// through the directory before it, so an anchor binds the cache directory; Windows resolves .. by name, and
// cache-bound-lexical.test.ts covers what happens there.
const anchored = process.platform !== "win32";
const temporaries: string[] = [];
const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const anchorName = /^\.osnova-bound-[0-9a-f-]{36}$/;
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

// As retarget and restore, within one synchronous call.
function retargetSync(parent: string, elsewhere: string): void {
  nodeFs.renameSync(parent, `${parent}-saved`);
  nodeFs.symlinkSync(elsewhere, parent, "dir");
}

function restoreSync(parent: string): void {
  if (!nodeFs.lstatSync(parent).isSymbolicLink()) return;
  nodeFs.unlinkSync(parent);
  nodeFs.renameSync(`${parent}-saved`, parent);
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

describe.runIf(anchored)("withBoundCacheDir where the cache directory cannot be bound", () => {
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
    expect(await fs.readdir(cacheDir)).toEqual([expect.stringMatching(anchorName)]);
  });

  it("keeps one empty anchor in a cache directory left as it was, and binds the next run through it", async () => {
    const temporary = await temporaryDir();
    const cacheDir = path.join(temporary, "cache");
    const identity = await ensureCacheDir(cacheDir);
    const run = async (): Promise<void> => await withBoundCacheDir(cacheDir, identity, async () => {
      await cacheFs.mkdir(path.join(cacheDir, "tree", "branch"), { recursive: true });
      await cacheFs.writeFile(path.join(cacheDir, "tree", "branch", "leaf"), "kept");
      await cacheFs.rm(path.join(cacheDir, "tree"), { recursive: true });
    });
    await run();
    const kept = await fs.readdir(cacheDir);
    expect(kept).toEqual([expect.stringMatching(anchorName)]);
    expect(await fs.readdir(path.join(cacheDir, kept[0] ?? ""))).toEqual([]);
    await run();
    expect(await fs.readdir(cacheDir)).toEqual(kept);
  });

  it("fails the run that finds its kept anchor removed, and anchors the next one anew", async () => {
    const temporary = await temporaryDir();
    const cacheDir = path.join(temporary, "cache");
    const identity = await ensureCacheDir(cacheDir);
    const write = async (name: string): Promise<unknown> => await withBoundCacheDir(cacheDir, identity, async () =>
      await cacheFs.writeFile(path.join(cacheDir, name), name)).then(() => "written", (error: unknown) => error);
    expect(await write("first")).toBe("written");
    const [removed = ""] = (await fs.readdir(cacheDir)).filter((name) => anchorName.test(name));
    await fs.rmdir(path.join(cacheDir, removed));
    expect(await write("second")).toMatchObject({ diagnostic: { phase: "cache", path: cacheDir, code: "cache-changing" } });
    expect(await write("third")).toBe("written");
    const left = (await fs.readdir(cacheDir)).sort();
    expect(left).toEqual([expect.stringMatching(anchorName), "first", "third"]);
    expect(left[0]).not.toBe(removed);
  });

  it("removes the anchor of a cache directory once more recent ones displace it", async () => {
    const temporary = await temporaryDir();
    const dirs = ["a", "b", "c", "d", "e", "f"].map((name) => path.join(temporary, name));
    for (const dir of dirs) {
      const identity = await ensureCacheDir(dir);
      await withBoundCacheDir(dir, identity, async () => await cacheFs.writeFile(path.join(dir, "file"), dir));
    }
    await vi.waitFor(async () => expect(await fs.readdir(dirs[0] ?? "")).toEqual(["file"]));
    expect((await fs.readdir(dirs[5] ?? "")).sort()).toEqual([expect.stringMatching(anchorName), "file"]);
  });

  it("removes its anchors when the process exits", async () => {
    const temporary = await temporaryDir();
    const cacheDir = path.join(temporary, "cache");
    const bound = pathToFileURL(path.resolve("src/cache/bound.ts")).href;
    const script = `
      import { promises } from "node:fs";
      const stat = promises.stat.bind(promises);
      promises.stat = async (target, ...rest) => {
        if (String(target).startsWith("/proc/self/fd/")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return await stat(target, ...rest);
      };
      const { cacheFs, ensureCacheDir, withBoundCacheDir } = await import(${JSON.stringify(bound)});
      const dir = ${JSON.stringify(cacheDir)};
      const identity = await ensureCacheDir(dir);
      await withBoundCacheDir(dir, identity, async () => await cacheFs.writeFile(dir + "/file", "x"));
      process.stdout.write(JSON.stringify((await promises.readdir(dir)).sort()));
    `;
    const during = JSON.parse(execFileSync(process.execPath, ["--import", tsx, "--input-type=module", "-e", script], { encoding: "utf8" })) as string[];
    expect(during).toEqual([expect.stringMatching(anchorName), "file"]);
    expect(await fs.readdir(cacheDir)).toEqual(["file"]);
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

  // Retargets the parent inside the first call of name on a path the condition accepts, and restores it when restore
  // says, so a call made between the two resolves the cache path into the other directory.
  function retargetedAround(name: "lstat" | "mkdir" | "rename" | "rm", parent: string, elsewhere: string, accept: (target: string) => boolean, until: "after the call" | "never"): () => boolean {
    const original = fs[name].bind(fs) as (...args: unknown[]) => Promise<unknown>;
    let done = false;
    vi.spyOn(fs, name).mockImplementation((async (...args: unknown[]) => {
      if (done || !accept(String(args[0]))) return await original(...args);
      done = true;
      await retarget(parent, elsewhere);
      try {
        return await original(...args);
      } finally {
        if (until === "after the call") await restore(parent);
      }
    }) as never);
    return () => done;
  }

  async function anchoredWrite(cacheDir: string): Promise<unknown> {
    const identity = await ensureCacheDir(cacheDir);
    return await withBoundCacheDir(cacheDir, identity, async () => await cacheFs.writeFile(path.join(cacheDir, "entry", "new"), "x"))
      .then(() => "written", (error: unknown) => error);
  }

  // What dir holds besides the one empty anchor it must hold.
  async function besidesItsAnchor(dir: string): Promise<Record<string, string>> {
    const found = await contents(dir);
    const [anchor = "", ...more] = Object.keys(found).filter((name) => anchorName.test(name));
    expect(more).toEqual([]);
    expect(found[anchor]).toBe("dir");
    expect(Object.keys(found).filter((name) => name.startsWith(`${anchor}${path.sep}`))).toEqual([]);
    delete found[anchor];
    return found;
  }

  // Retargets the parent around the first mkdir, by either API, of a name an anchor or its acquisition takes: from
  // before the call until after it, or from after the call on, so that what runs then resolves the cache path into the
  // other directory.
  function retargetedAroundTheAnchor(parent: string, elsewhere: string, window: "during the call" | "during and after the call" | "after the call"): () => boolean {
    const mkdir = fs.mkdir.bind(fs) as (...args: unknown[]) => Promise<unknown>;
    const mkdirSync = nodeFs.mkdirSync.bind(nodeFs) as (...args: unknown[]) => unknown;
    let done = false;
    const accept = (target: unknown): boolean => !done && path.basename(String(target)).startsWith(".osnova-bound");
    vi.spyOn(fs, "mkdir").mockImplementation((async (...args: unknown[]) => {
      if (!accept(args[0])) return await mkdir(...args);
      done = true;
      if (window !== "after the call") await retarget(parent, elsewhere);
      try {
        return await mkdir(...args);
      } finally {
        if (window === "during the call") await restore(parent);
        else if (window === "after the call") await retarget(parent, elsewhere);
      }
    }) as never);
    vi.spyOn(nodeFs, "mkdirSync").mockImplementation(((...args: unknown[]) => {
      if (!accept(args[0])) return mkdirSync(...args);
      done = true;
      if (window !== "after the call") retargetSync(parent, elsewhere);
      try {
        return mkdirSync(...args);
      } finally {
        if (window === "during the call") restoreSync(parent);
        else if (window === "after the call") retargetSync(parent, elsewhere);
      }
    }) as never);
    return () => done;
  }

  it("makes the anchor in the cache directory, and changes nothing in the other cache, when a parent is retargeted during the creation of the anchor and restored after it", async () => {
    const { parent, elsewhere, cacheDir, otherCacheDir } = await twinCaches();
    const ours = await contents(cacheDir);
    const others = await contents(otherCacheDir);
    const cwd = process.cwd();
    const retargeted = retargetedAroundTheAnchor(parent, elsewhere, "during the call");
    const outcome = await anchoredWrite(cacheDir);
    vi.restoreAllMocks();
    expect(retargeted()).toBe(true);
    expect(outcome).toBe("written");
    expect(await contents(otherCacheDir)).toEqual(others);
    expect(await besidesItsAnchor(cacheDir)).toEqual({ ...ours, [path.join("entry", "new")]: `file:${Buffer.from("x").toString("base64")}` });
    expect(process.cwd()).toBe(cwd);
  });

  it("fails, and changes nothing in the other cache, when a parent is retargeted during the creation of the anchor and stays so", async () => {
    const { parent, elsewhere, cacheDir, otherCacheDir } = await twinCaches();
    const ours = await contents(cacheDir);
    const others = await contents(otherCacheDir);
    const cwd = process.cwd();
    const retargeted = retargetedAroundTheAnchor(parent, elsewhere, "during and after the call");
    const outcome = await anchoredWrite(cacheDir);
    vi.restoreAllMocks();
    await restore(parent);
    expect(retargeted()).toBe(true);
    expect(outcome).toMatchObject({ diagnostic: { phase: "cache", path: cacheDir, code: "cache-changing" } });
    expect(await contents(otherCacheDir)).toEqual(others);
    // The anchor stays behind, empty, since the run ended with the cache path naming another directory.
    expect(await besidesItsAnchor(cacheDir)).toEqual(ours);
    expect(process.cwd()).toBe(cwd);
  });

  it("fails, and changes nothing in the other cache, when a parent is retargeted once the anchor is made", async () => {
    const { parent, elsewhere, cacheDir, otherCacheDir } = await twinCaches();
    const ours = await contents(cacheDir);
    const others = await contents(otherCacheDir);
    const retargeted = retargetedAroundTheAnchor(parent, elsewhere, "after the call");
    const outcome = await anchoredWrite(cacheDir);
    vi.restoreAllMocks();
    await restore(parent);
    expect(retargeted()).toBe(true);
    expect(outcome).toMatchObject({ diagnostic: { phase: "cache", path: cacheDir, code: "cache-changing" } });
    expect(await contents(otherCacheDir)).toEqual(others);
    expect(await besidesItsAnchor(cacheDir)).toEqual(ours);
  });

  it("fails, and changes nothing in either cache, when a parent is retargeted as the cache directory is entered to make the anchor and restored after it", async () => {
    const { parent, elsewhere, cacheDir, otherCacheDir } = await twinCaches();
    const ours = await contents(cacheDir);
    const others = await contents(otherCacheDir);
    const cwd = process.cwd();
    const chdir = process.chdir.bind(process);
    let retargeted = false;
    vi.spyOn(process, "chdir").mockImplementation((target: string) => {
      if (retargeted || target !== cacheDir) return chdir(target);
      retargeted = true;
      retargetSync(parent, elsewhere);
      try {
        chdir(target);
      } finally {
        restoreSync(parent);
      }
    });
    const outcome = await anchoredWrite(cacheDir);
    vi.restoreAllMocks();
    expect(retargeted).toBe(true);
    expect(outcome).toMatchObject({ diagnostic: { phase: "cache", path: cacheDir, code: "cache-changing" } });
    expect(await contents(otherCacheDir)).toEqual(others);
    expect(await contents(cacheDir)).toEqual(ours);
    expect(process.cwd()).toBe(cwd);
  });

  it("refuses every change within the cache directory in a worker thread, which cannot make an anchor", async () => {
    const temporary = await temporaryDir();
    const cacheDir = path.join(temporary, "cache");
    const bound = pathToFileURL(path.resolve("src/cache/bound.ts")).href;
    const script = `
      const { promises } = require("node:fs");
      const { parentPort } = require("node:worker_threads");
      const stat = promises.stat.bind(promises);
      promises.stat = async (target, ...rest) => {
        if (String(target).startsWith("/proc/self/fd/")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return await stat(target, ...rest);
      };
      require(${JSON.stringify(createRequire(import.meta.url).resolve("tsx/esm/api"))}).register();
      (async () => {
        const { cacheFs, ensureCacheDir, withBoundCacheDir } = await import(${JSON.stringify(bound)});
        const dir = ${JSON.stringify(cacheDir)};
        const identity = await ensureCacheDir(dir);
        const outcome = await withBoundCacheDir(dir, identity, async () => await cacheFs.writeFile(dir + "/file", "x"))
          .then(() => "written", (error) => error.diagnostic?.code ?? String(error));
        parentPort.postMessage({ outcome, entries: await promises.readdir(dir) });
      })();
    `;
    const worker = new Worker(script, { eval: true });
    const answer = await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    await worker.terminate();
    expect(answer).toEqual({ outcome: "cache-unbindable", entries: [] });
  });

  // A recursive rm first moves its target into the anchor, under a name of its own, and then removes it there, starting
  // with an lstat of what it moved.
  const stagedInAnchor = (target: string): boolean => anchorName.test(path.basename(path.dirname(target)));

  it("fails, and changes nothing in the other cache, when a parent is retargeted during the removal of a tree moved into the anchor and restored after it", async () => {
    const { parent, elsewhere, cacheDir, otherCacheDir } = await twinCaches();
    const identity = await ensureCacheDir(cacheDir);
    const ours = await contents(cacheDir);
    const others = await contents(otherCacheDir);
    const retargeted = retargetedAround("lstat", parent, elsewhere, stagedInAnchor, "after the call");
    const outcome = await withBoundCacheDir(cacheDir, identity, async () => await cacheFs.rm(path.join(cacheDir, "tree"), { recursive: true, force: true }))
      .then(() => "removed", (error: unknown) => error);
    vi.restoreAllMocks();
    expect(retargeted()).toBe(true);
    expect(outcome).toMatchObject({ diagnostic: { phase: "cache", path: cacheDir, code: "cache-changing" } });
    expect(await contents(otherCacheDir)).toEqual(others);
    // The run drops its anchor, and with it the tree moved into it.
    expect(await contents(cacheDir)).toEqual(Object.fromEntries(Object.entries(ours).filter(([name]) => name.split(path.sep)[0] !== "tree")));
  });

  // Retargets the parent as the first lstat, by either API, of a target the condition accepts settles, which is how a
  // removal finds its target, and restores it as the check after the change begins, so only the deletion that follows,
  // which Node's rm lets take a missing path as removed, resolves the cache path into the other directory.
  function retargetedOnceRmFindsItsTarget(cacheDir: string, parent: string, elsewhere: string, accept: (target: string) => boolean): () => boolean {
    const lstat = nodeFs.lstat.bind(nodeFs) as (...args: unknown[]) => void;
    const lstatPromise = fs.lstat.bind(fs) as (...args: unknown[]) => Promise<unknown>;
    const stat = vi.mocked(fs.stat).getMockImplementation() as (...args: unknown[]) => Promise<unknown>;
    let state: "idle" | "retargeted" | "restored" = "idle";
    vi.spyOn(nodeFs, "lstat").mockImplementation(((...args: unknown[]) => {
      const callback = args.at(-1);
      if (state !== "idle" || typeof callback !== "function" || !accept(String(args[0]))) return lstat(...args);
      return lstat(...args.slice(0, -1), (...results: unknown[]) => {
        retargetSync(parent, elsewhere);
        state = "retargeted";
        (callback as (...results: unknown[]) => void)(...results);
      });
    }) as never);
    vi.spyOn(fs, "lstat").mockImplementation((async (...args: unknown[]) => {
      const settled = await lstatPromise(...args).then((value) => ({ value }), (error: unknown) => ({ error }));
      if (state === "idle" && accept(String(args[0]))) {
        await retarget(parent, elsewhere);
        state = "retargeted";
      }
      if ("error" in settled) throw settled.error;
      return settled.value;
    }) as never);
    vi.spyOn(fs, "stat").mockImplementation((async (...args: unknown[]) => {
      if (args[0] === cacheDir && state === "retargeted") {
        await restore(parent);
        state = "restored";
      }
      return await stat(...args);
    }) as never);
    return () => state === "restored";
  }

  it("fails, and changes nothing in either cache, when a parent is retargeted after rm validates an ordinary deletion and restored before it returns", async () => {
    const { parent, elsewhere, cacheDir, otherCacheDir } = await twinCaches();
    const identity = await ensureCacheDir(cacheDir);
    const ours = await contents(cacheDir);
    const others = await contents(otherCacheDir);
    const target = path.join(cacheDir, "entry", "file");
    const retargeted = retargetedOnceRmFindsItsTarget(cacheDir, parent, elsewhere, (given) => given.includes(".osnova-bound-") && path.resolve(given) === target);
    const outcome = await withBoundCacheDir(cacheDir, identity, async () => await cacheFs.rm(target, { force: true }))
      .then(() => "removed", (error: unknown) => error);
    vi.restoreAllMocks();
    await restore(parent);
    expect(retargeted()).toBe(true);
    expect(outcome).toMatchObject({ diagnostic: { phase: "cache", path: cacheDir, code: "cache-changing" } });
    expect(await contents(otherCacheDir)).toEqual(others);
    expect(await contents(cacheDir)).toEqual(ours);
  });

  it("fails, and changes nothing in the other cache, when a parent is retargeted after rm validates a tree moved into the anchor and restored before it returns", async () => {
    const { parent, elsewhere, cacheDir, otherCacheDir } = await twinCaches();
    const identity = await ensureCacheDir(cacheDir);
    const ours = await contents(cacheDir);
    const others = await contents(otherCacheDir);
    const retargeted = retargetedOnceRmFindsItsTarget(cacheDir, parent, elsewhere, (given) => stagedInAnchor(path.resolve(given)));
    const outcome = await withBoundCacheDir(cacheDir, identity, async () => await cacheFs.rm(path.join(cacheDir, "tree"), { recursive: true, force: true }))
      .then(() => "removed", (error: unknown) => error);
    vi.restoreAllMocks();
    await restore(parent);
    expect(retargeted()).toBe(true);
    expect(outcome).toMatchObject({ diagnostic: { phase: "cache", path: cacheDir, code: "cache-changing" } });
    expect(await contents(otherCacheDir)).toEqual(others);
    // The run drops its anchor, and with it the tree moved into it.
    expect(await contents(cacheDir)).toEqual(Object.fromEntries(Object.entries(ours).filter(([name]) => name.split(path.sep)[0] !== "tree")));
  });

  it("names the requested path, not the anchor, in the error of a removal that fails once its tree is moved into the anchor", async () => {
    const temporary = await temporaryDir();
    const cacheDir = path.join(temporary, "cache");
    const identity = await ensureCacheDir(cacheDir);
    let failing = "";
    // Where target lies within a tree moved into the anchor, its path relative to that tree.
    const withinStaged = (target: string): string | undefined => {
      const parts = target.split(path.sep);
      const at = parts.findIndex((part) => anchorName.test(part));
      return at < 0 || at + 1 >= parts.length ? undefined : parts.slice(at + 2).join(path.sep);
    };
    for (const name of ["unlink", "rmdir"] as const) {
      const original = fs[name].bind(fs) as (...args: unknown[]) => Promise<unknown>;
      vi.spyOn(fs, name).mockImplementation((async (...args: unknown[]) => {
        const target = String(args[0]);
        if (withinStaged(target) !== failing) return await original(...args);
        throw Object.assign(new Error(`EACCES: permission denied, ${name} '${target}'`), { code: "EACCES", errno: -13, syscall: name, path: target });
      }) as never);
    }
    const outcomes = await withBoundCacheDir(cacheDir, identity, async () => {
      await cacheFs.mkdir(path.join(cacheDir, "tree", "branch"), { recursive: true });
      await cacheFs.writeFile(path.join(cacheDir, "tree", "branch", "leaf"), "x");
      await cacheFs.mkdir(path.join(cacheDir, "other"));
      const settle = async (target: string, inside: string): Promise<unknown> => {
        failing = inside;
        return await cacheFs.rm(target, { recursive: true }).then(() => "removed", (error: unknown) => {
          const failure = error as NodeJS.ErrnoException;
          return { code: failure.code, path: failure.path, message: failure.message };
        });
      };
      return [await settle(path.join(cacheDir, "tree"), path.join("branch", "leaf")), await settle(path.join(cacheDir, "other"), "")];
    });
    const leaf = path.join(cacheDir, "tree", "branch", "leaf");
    const other = path.join(cacheDir, "other");
    expect(outcomes).toEqual([
      { code: "EACCES", path: leaf, message: `EACCES: permission denied, unlink '${leaf}'` },
      { code: "EACCES", path: other, message: `EACCES: permission denied, rmdir '${other}'` },
    ]);
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

describe.runIf(anchored)("refreshWorkspaceWitnessed where the cache directory cannot be bound", () => {
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

  it("does no anchor work on a warm refresh of a cache directory a run of this process already bound", async () => {
    const temporary = await temporaryDir();
    const root = path.join(temporary, "root");
    const cacheDir = path.join(temporary, "cache");
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "a.ts"), "export function warm() { return 1; }\n");
    await refreshWorkspaceWitnessed(root, { cacheDir });
    const [anchor] = (await fs.readdir(cacheDir)).filter((name) => anchorName.test(name));
    expect(anchor).toBeDefined();
    const calls: string[] = [];
    for (const name of ["access", "copyFile", "lstat", "mkdir", "readFile", "readdir", "rename", "rm", "rmdir", "stat", "unlink", "writeFile"] as const) {
      const original = (vi.isMockFunction(fs[name]) ? vi.mocked(fs[name]).getMockImplementation() : undefined) ?? (fs[name].bind(fs) as (...args: unknown[]) => Promise<unknown>);
      vi.spyOn(fs, name).mockImplementation((async (...args: unknown[]) => {
        calls.push(`${name} ${String(args[0])}`);
        return await (original as (...args: unknown[]) => Promise<unknown>)(...args);
      }) as never);
    }
    let changes = 0;
    for (const name of ["copyFile", "mkdir", "rename", "rm", "rmdir", "unlink", "writeFile"] as const) {
      const original = cacheFs[name] as (...args: unknown[]) => Promise<unknown>;
      vi.spyOn(cacheFs, name).mockImplementation((async (...args: unknown[]) => {
        if (args.slice(0, name === "copyFile" || name === "rename" ? 2 : 1).some((target) => String(target) === cacheDir || String(target).startsWith(`${cacheDir}${path.sep}`))) changes += 1;
        return await original(...args);
      }) as never);
    }
    expect(names((await refreshWorkspaceWitnessed(root, { cacheDir })).index)).toEqual(["warm"]);
    expect(changes).toBeGreaterThan(0);
    // ensureCacheDir takes one stat of the cache directory, and each change is checked before and after it.
    expect(calls.filter((call) => call === `stat ${cacheDir}`)).toHaveLength(2 * changes + 1);
    expect(calls.filter((call) => /\.osnova-bound/.test(call) && !call.includes(`${path.sep}${anchor}${path.sep}`))).toEqual([]);
    expect(calls.filter((call) => call.endsWith(`${path.sep}${anchor}`))).toEqual([]);
    expect((await fs.readdir(cacheDir)).filter((name) => name.includes(".osnova-bound"))).toEqual([anchor]);
  });

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
  function retargetedDuring(name: "writeFile" | "unlink", parent: string, elsewhere: string, accept: (target: string) => boolean): () => boolean {
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
    // The rm of an evicted entry's file deletes it by unlink.
    const retargeted = retargetedDuring("unlink", parent, elsewhere, (target) =>
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
