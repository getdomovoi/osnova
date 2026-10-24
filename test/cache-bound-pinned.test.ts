import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { constants, promises as fs, watch } from "node:fs";
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
const linux = process.platform === "linux";
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

// The working directories of this process's children, as /proc names them on Linux.
async function childDirs(): Promise<string[]> {
  const dirs: string[] = [];
  for (const name of (await fs.readdir("/proc")).filter((entry) => /^\d+$/.test(entry))) {
    const stat = await fs.readFile(`/proc/${name}/stat`, "utf8").catch(() => "");
    if (stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1] !== String(process.pid)) continue;
    const cwd = await fs.readlink(`/proc/${name}/cwd`).catch(() => undefined);
    if (cwd !== undefined) dirs.push(cwd);
  }
  return dirs;
}

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

  // A pin removed again once the run fails would leave no trace, so each open is followed by a look at the other cache.
  it("creates no pin outside the cache directory when the cache path names another directory as the run begins", async () => {
    const { parent, elsewhere, cacheDir, otherCacheDir } = await twinCaches();
    const identity = await ensureCacheDir(cacheDir);
    await retarget(parent, elsewhere);
    const open = fs.open.bind(fs) as (...args: unknown[]) => Promise<unknown>;
    const landed: string[] = [];
    vi.spyOn(fs, "open").mockImplementation((async (...args: unknown[]) => {
      const settled = await open(...args).then((value) => ({ value }), (error: unknown) => ({ error }));
      landed.push(...await pins(otherCacheDir));
      if ("error" in settled) throw settled.error;
      return settled.value;
    }) as never);
    const outcome = await withBoundCacheDir(cacheDir, identity, async () => {}).then(() => "ran", (error: unknown) => error);
    vi.mocked(fs.open).mockRestore();
    await restore(parent);
    expect(outcome).toMatchObject({ diagnostic: { phase: "cache", path: cacheDir, code: "cache-changing" } });
    expect(landed).toEqual([]);
  });

  // Windows refuses an open of a directory held without sharing with EBUSY, as another process may hold the cache
  // directory.
  it("waits while the cache directory is held without sharing, then pins it", async () => {
    const { cacheDir } = await twinCaches();
    const identity = await ensureCacheDir(cacheDir);
    const open = fs.open.bind(fs) as (...args: unknown[]) => Promise<unknown>;
    let refused = 0;
    vi.spyOn(fs, "open").mockImplementation((async (...args: unknown[]) => {
      if (String(args[0]) === cacheDir && refused < 3) {
        refused += 1;
        throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${cacheDir}'`), { code: "EBUSY" });
      }
      return await open(...args);
    }) as never);
    const outcome = await withBoundCacheDir(cacheDir, identity, async () => "ran").then((value) => value, (error: unknown) => error);
    expect(refused).toBe(3);
    expect(outcome).toBe("ran");
  });

  it("fails with cache-write-failed, creating no pin, once the cache directory stays held without sharing", async () => {
    const { cacheDir } = await twinCaches();
    const identity = await ensureCacheDir(cacheDir);
    const open = fs.open.bind(fs) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(fs, "open").mockImplementation((async (...args: unknown[]) => {
      if (String(args[0]) === cacheDir) throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${cacheDir}'`), { code: "EBUSY" });
      return await open(...args);
    }) as never);
    let ran = false;
    const outcome = await withBoundCacheDir(cacheDir, identity, async () => { ran = true; }).then(() => "ran", (error: unknown) => error);
    expect(outcome).toMatchObject({ diagnostic: { phase: "cache", path: cacheDir, code: "cache-write-failed" }, cause: { code: "EBUSY" } });
    expect(ran).toBe(false);
    expect(await pins(cacheDir)).toEqual([]);
  }, 15_000);

  // The holding helper is in one directory at a time, so runs of one process take turns at it.
  it("lets runs of one process hold the cache directory in turn", async () => {
    const { cacheDir } = await twinCaches();
    const identity = await ensureCacheDir(cacheDir);
    const open = fs.open.bind(fs) as (...args: unknown[]) => Promise<{ close: () => Promise<void> }>;
    let holding = 0;
    let collisions = 0;
    vi.spyOn(fs, "open").mockImplementation((async (...args: unknown[]) => {
      if (String(args[0]) !== cacheDir) return await open(...args);
      if (holding > 0) {
        collisions += 1;
        throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${cacheDir}'`), { code: "EBUSY" });
      }
      holding += 1;
      const held = await open(...args).catch((error: unknown) => {
        holding -= 1;
        throw error;
      });
      const close = held.close.bind(held);
      held.close = async () => {
        holding -= 1;
        await close();
      };
      return held;
    }) as never);
    const outcomes = await Promise.all([1, 2, 3].map(async (run) => await withBoundCacheDir(cacheDir, identity, async () => run)));
    expect(outcomes).toEqual([1, 2, 3]);
    expect(collisions).toBe(0);
  });

  // Windows opens a process's working directory sharing reads and writes but not removal, so a helper process whose
  // working directory is the cache directory keeps it, and every directory above it, in place as the pin is created,
  // while its readers, watchers and other runs' changes go on. An entry held open would not: it can be moved away, and
  // the cache directory with it. An open of the directory itself would have to share nothing and so refuse watchers.
  it.runIf(linux).each([
    ["a populated", true],
    ["an empty", false],
  ] as const)("holds %s cache directory as a helper's working directory from the check of the directory until its pin is open", async (_label, populated) => {
    const { cacheDir } = await twinCaches();
    if (!populated) {
      await fs.rm(cacheDir, { recursive: true });
      await fs.mkdir(cacheDir);
    }
    const identity = await ensureCacheDir(cacheDir);
    const open = fs.open.bind(fs) as (...args: unknown[]) => Promise<unknown>;
    let during: string[] | undefined;
    vi.spyOn(fs, "open").mockImplementation((async (...args: unknown[]) => {
      if (during === undefined && path.basename(String(args[0])).startsWith(".osnova-bound-")) during = await childDirs();
      return await open(...args);
    }) as never);
    const outcome = await withBoundCacheDir(cacheDir, identity, async () => await childDirs());
    expect(during).toContain(cacheDir);
    expect(outcome).not.toContain(cacheDir);
    expect(await childDirs()).not.toContain(cacheDir);
  });

  it("pins the cache directory without opening any entry inside it", async () => {
    const { cacheDir } = await twinCaches();
    const identity = await ensureCacheDir(cacheDir);
    const open = fs.open.bind(fs) as (...args: unknown[]) => Promise<unknown>;
    let refused = 0;
    vi.spyOn(fs, "open").mockImplementation((async (...args: unknown[]) => {
      const target = String(args[0]);
      if (path.dirname(target) === cacheDir && !path.basename(target).startsWith(".osnova-bound-")) {
        refused += 1;
        throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${target}'`), { code: "EBUSY" });
      }
      return await open(...args);
    }) as never);
    const outcome = await withBoundCacheDir(cacheDir, identity, async () => {
      await cacheFs.writeFile(path.join(cacheDir, "entry", "new"), "x");
      return await pins(cacheDir);
    });
    expect(refused).toBe(0);
    expect(outcome).toHaveLength(1);
    expect(await pins(cacheDir)).toEqual([]);
  });

  it("lists the cache directory while another run holds it without sharing", async () => {
    const { cacheDir } = await twinCaches();
    const identity = await ensureCacheDir(cacheDir);
    const readdir = fs.readdir.bind(fs) as (...args: unknown[]) => Promise<unknown>;
    let refused = 0;
    vi.spyOn(fs, "readdir").mockImplementation((async (...args: unknown[]) => {
      if (path.resolve(String(args[0])) === cacheDir && refused < 2) {
        refused += 1;
        throw Object.assign(new Error(`EBUSY: resource busy or locked, scandir '${cacheDir}'`), { code: "EBUSY" });
      }
      return await readdir(...args);
    }) as never);
    const listed = await withBoundCacheDir(cacheDir, identity, async () => await cacheFs.readdir(cacheDir));
    expect(refused).toBe(2);
    expect(listed.filter((name) => !name.startsWith(".osnova-bound-")).sort()).toEqual(["entry", "tree"]);
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

  // The directory the cache path names is open before the pin is created, so a parent cannot be retargeted between
  // the check of that directory and the creation of the pin.
  it("keeps a parent from being retargeted as the pin is created, so no pin lands in the other cache", async () => {
    const { parent, elsewhere, cacheDir, otherCacheDir } = await twinCaches();
    const identity = await ensureCacheDir(cacheDir);
    const open = fs.open.bind(fs) as (...args: unknown[]) => Promise<unknown>;
    let refused: unknown;
    const landed: string[] = [];
    vi.spyOn(fs, "open").mockImplementation((async (...args: unknown[]) => {
      if (refused !== undefined || !path.basename(String(args[0])).startsWith(".osnova-bound-")) return await open(...args);
      refused = await retarget(parent, elsewhere).then(() => "renamed", (error: unknown) => (error as NodeJS.ErrnoException).code);
      try {
        return await open(...args);
      } finally {
        landed.push(...await pins(otherCacheDir));
        await restore(parent);
      }
    }) as never);
    const outcome = await withBoundCacheDir(cacheDir, identity, async () => "ran").then((value) => value, (error: unknown) => error);
    vi.restoreAllMocks();
    expect(["EPERM", "EACCES", "EBUSY"]).toContain(refused);
    expect(landed).toEqual([]);
    expect(outcome).toBe("ran");
  });

  // The cache directory is a helper's working directory, held without delete sharing, until the pin is open, so it
  // cannot be moved aside and replaced with a junction between the check of its identity and the creation of the pin.
  it("keeps the cache directory from being replaced as the pin is created, so no pin lands in the other cache", async () => {
    const { cacheDir, otherCacheDir } = await twinCaches();
    const identity = await ensureCacheDir(cacheDir);
    const open = fs.open.bind(fs) as (...args: unknown[]) => Promise<unknown>;
    let refused: unknown;
    const landed: string[] = [];
    vi.spyOn(fs, "open").mockImplementation((async (...args: unknown[]) => {
      if (refused !== undefined || !path.basename(String(args[0])).startsWith(".osnova-bound-")) return await open(...args);
      refused = await retarget(cacheDir, otherCacheDir).then(() => "renamed", (error: unknown) => (error as NodeJS.ErrnoException).code);
      try {
        return await open(...args);
      } finally {
        landed.push(...await pins(otherCacheDir));
        await restore(cacheDir);
      }
    }) as never);
    const outcome = await withBoundCacheDir(cacheDir, identity, async () => "ran").then((value) => value, (error: unknown) => error);
    vi.restoreAllMocks();
    expect(["EPERM", "EACCES", "EBUSY"]).toContain(refused);
    expect(landed).toEqual([]);
    expect(outcome).toBe("ran");
  });

  // An entry held open with delete sharing can be renamed out of the cache directory, after which nothing inside the
  // cache directory is open and it can be replaced with a junction before the pin is created.
  it("keeps the cache directory from being replaced once its entries are moved away as the pin is created, so no pin lands in the other cache", async () => {
    const { parent, cacheDir, otherCacheDir } = await twinCaches();
    const identity = await ensureCacheDir(cacheDir);
    const open = fs.open.bind(fs) as (...args: unknown[]) => Promise<unknown>;
    let moved: unknown;
    let refused: unknown;
    const landed: string[] = [];
    vi.spyOn(fs, "open").mockImplementation((async (...args: unknown[]) => {
      if (refused !== undefined || !path.basename(String(args[0])).startsWith(".osnova-bound-")) return await open(...args);
      moved = await Promise.all((await fs.readdir(cacheDir)).map(async (name) => await fs.rename(path.join(cacheDir, name), path.join(parent, `moved-${name}`))
        .then(() => "moved", (error: unknown) => (error as NodeJS.ErrnoException).code)));
      refused = await retarget(cacheDir, otherCacheDir).then(() => "renamed", (error: unknown) => (error as NodeJS.ErrnoException).code);
      try {
        return await open(...args);
      } finally {
        landed.push(...await pins(otherCacheDir));
        await restore(cacheDir);
      }
    }) as never);
    const outcome = await withBoundCacheDir(cacheDir, identity, async () => "ran").then((value) => value, (error: unknown) => error);
    vi.restoreAllMocks();
    expect(moved).toEqual(["moved", "moved"]);
    expect(["EPERM", "EACCES", "EBUSY"]).toContain(refused);
    expect(landed).toEqual([]);
    expect(outcome).toBe("ran");
  });

  // With no entry to hold, a hold of the cache directory itself would have to share nothing, which the watcher's open
  // of the directory refuses.
  it("pins an empty cache directory while a watcher is open on it", async () => {
    const cacheDir = path.join(await temporaryDir(), "cache");
    const identity = await ensureCacheDir(cacheDir);
    const watcher = watch(cacheDir);
    try {
      const outcome = await withBoundCacheDir(cacheDir, identity, async () => "ran").then((value) => value, (error: unknown) => error);
      expect(outcome).toBe("ran");
    } finally {
      watcher.close();
    }
  });

  it("leaves the cache directory free to be renamed once the run has ended", async () => {
    const { cacheDir } = await twinCaches();
    const identity = await ensureCacheDir(cacheDir);
    await withBoundCacheDir(cacheDir, identity, async () => "ran");
    await fs.rename(cacheDir, `${cacheDir}-saved`);
    await fs.rename(`${cacheDir}-saved`, cacheDir);
  });

  it("waits for a hold of the cache directory without sharing to end, then runs", async () => {
    const { cacheDir } = await twinCaches();
    const identity = await ensureCacheDir(cacheDir);
    const held = await fs.open(cacheDir, constants.O_RDONLY | 0x10000000);
    const listing = await fs.readdir(cacheDir).then(() => "listed", (error: unknown) => (error as NodeJS.ErrnoException).code);
    const released = new Promise<void>((resolve) => setTimeout(() => void held.close().then(resolve), 200));
    const outcome = await withBoundCacheDir(cacheDir, identity, async () => "ran").then((value) => value, (error: unknown) => error);
    await released;
    expect(listing).toBe("EBUSY");
    expect(outcome).toBe("ran");
  });

  // libuv's watcher keeps the directory it watches open, so a run that had to share nothing with every other open of
  // the cache directory could not pin it while the watcher runs.
  it("pins the cache directory while a watcher is open on it", async () => {
    const { cacheDir } = await twinCaches();
    const identity = await ensureCacheDir(cacheDir);
    const watcher = watch(cacheDir);
    try {
      const outcome = await withBoundCacheDir(cacheDir, identity, async () => "ran").then((value) => value, (error: unknown) => error);
      expect(outcome).toBe("ran");
    } finally {
      watcher.close();
    }
  });

  it("lets the cache directory be listed and changed by others as the pin is created", async () => {
    const { cacheDir } = await twinCaches();
    const identity = await ensureCacheDir(cacheDir);
    const open = fs.open.bind(fs) as (...args: unknown[]) => Promise<unknown>;
    let others: unknown;
    vi.spyOn(fs, "open").mockImplementation((async (...args: unknown[]) => {
      if (others !== undefined || !path.basename(String(args[0])).startsWith(".osnova-bound-")) return await open(...args);
      others = await Promise.all([
        fs.readdir(cacheDir).then(() => "listed", (error: unknown) => (error as NodeJS.ErrnoException).code),
        fs.rename(path.join(cacheDir, "entry", "file.tmp"), path.join(cacheDir, "entry", "file")).then(() => "renamed", (error: unknown) => (error as NodeJS.ErrnoException).code),
      ]);
      return await open(...args);
    }) as never);
    const outcome = await withBoundCacheDir(cacheDir, identity, async () => "ran").then((value) => value, (error: unknown) => error);
    vi.restoreAllMocks();
    expect(others).toEqual(["listed", "renamed"]);
    expect(outcome).toBe("ran");
  });

  it("binds concurrent runs of one process to the same cache directory", async () => {
    const { cacheDir } = await twinCaches();
    const identity = await ensureCacheDir(cacheDir);
    const outcomes = await Promise.all([1, 2, 3, 4].map(async (run) => await withBoundCacheDir(cacheDir, identity, async () => {
      await cacheFs.writeFile(path.join(cacheDir, "entry", `run-${run}`), String(run));
      return run;
    })));
    expect(outcomes).toEqual([1, 2, 3, 4]);
    expect(await pins(cacheDir)).toEqual([]);
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

  // A workspace may hold its own cache, and a watcher on it, as the MCP server keeps, then has the cache directory open.
  it("refreshes a workspace that is its own cache directory while a watcher is open on it", async () => {
    Object.defineProperty(process, "platform", platform);
    vi.restoreAllMocks();
    const root = path.join(await temporaryDir(), "root");
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "a.ts"), "export function pinned() { return 1; }\n");
    const watcher = watch(root, { recursive: true });
    try {
      for (let refresh = 0; refresh < 2; refresh += 1) {
        const { index } = await refreshWorkspaceWitnessed(root, { cacheDir: root });
        expect([...index.files.keys()]).toEqual(["a.ts"]);
      }
    } finally {
      watcher.close();
    }
    expect(await pins(root)).toEqual([]);
  });
});
