import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import childProcess, { execFileSync } from "node:child_process";
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
const identityOf = (stat: nodeFs.BigIntStats): string => `${stat.dev}:${stat.ino}`;
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
  vi.unstubAllEnvs();
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

// Retargets parent to elsewhere as the first call of name, in a helper process, on a path whose basename starts with
// starts, and whose directory's basename is within when given, begins; with restore, restores it as that call returns.
interface RetargetPlan {
  readonly name: "mkdirSync" | "rmSync" | "writeFileSync";
  readonly parent: string;
  readonly elsewhere: string;
  readonly within?: string | undefined;
  readonly starts: string;
  readonly restore: boolean;
}

// Has every helper process started from now on load a hook that follows the plan arm writes. A helper started before
// the plan is written follows it as well, and no helper follows it more than once.
async function retargetedInHelpers(): Promise<{ arm: (plan: RetargetPlan) => void; done: () => boolean }> {
  const dir = await temporaryDir();
  const planFile = path.join(dir, "plan.json");
  const doneFile = path.join(dir, "done");
  const hook = path.join(dir, "hook.cjs");
  await fs.writeFile(hook, `
    const fs = require("node:fs");
    const path = require("node:path");
    const [planFile, doneFile] = ${JSON.stringify([planFile, doneFile])};
    const unwrapped = { ...fs };
    for (const name of ["mkdirSync", "rmSync", "writeFileSync"]) {
      fs[name] = (...args) => {
        const plan = unwrapped.existsSync(planFile) && !unwrapped.existsSync(doneFile) ? JSON.parse(unwrapped.readFileSync(planFile, "utf8")) : undefined;
        const target = String(args[0]);
        if (plan === undefined || plan.name !== name || !path.basename(target).startsWith(plan.starts)
          || (plan.within !== undefined && path.basename(path.dirname(target)) !== plan.within)) return unwrapped[name](...args);
        unwrapped.writeFileSync(doneFile, "");
        unwrapped.renameSync(plan.parent, plan.parent + "-saved");
        unwrapped.symlinkSync(plan.elsewhere, plan.parent, "dir");
        try {
          return unwrapped[name](...args);
        } finally {
          if (plan.restore) {
            unwrapped.unlinkSync(plan.parent);
            unwrapped.renameSync(plan.parent + "-saved", plan.parent);
          }
        }
      };
    }
  `);
  const spawn = childProcess.spawn.bind(childProcess) as (...args: unknown[]) => unknown;
  vi.spyOn(childProcess, "spawn").mockImplementation(((...args: unknown[]) => {
    const given = args[1] as string[];
    return given[0] === "-e" ? spawn(args[0], ["--require", hook, ...given], ...args.slice(2)) : spawn(...args);
  }) as never);
  return { arm: (plan) => nodeFs.writeFileSync(planFile, JSON.stringify(plan)), done: () => nodeFs.existsSync(doneFile) };
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

  // A process that binds cache directory a and fails the recursive rm of a tree in it, as the helper of its anchor cannot
  // unlink the tree's leaf. With swap, it then removes the tree again, and the branch left in place is swapped for a link
  // to outside as the helper examines it. With displace, it then binds four more cache directories, which displace the
  // anchor. Each helper process loads a module first that wraps the fs functions it uses.
  async function afterAFailedRemoval(temporary: string, outside: string, swap: boolean, displace: boolean): Promise<{ failure: unknown; again: unknown; anchor: string; swapped: boolean }> {
    const phase = path.join(temporary, "phase");
    const made = path.join(temporary, "swapped");
    const hook = path.join(temporary, "hook.cjs");
    await fs.writeFile(hook, `
      const fs = require("node:fs");
      const path = require("node:path");
      const [phase, outside, made] = ${JSON.stringify([phase, outside, made])};
      const unlinkSync = fs.unlinkSync;
      fs.unlinkSync = (...args) => {
        if (fs.readFileSync(phase, "utf8") !== "fail" || args[0] !== "leaf") return unlinkSync(...args);
        throw Object.assign(new Error("EACCES: permission denied, unlink 'leaf'"), { code: "EACCES", errno: -13, syscall: "unlink", path: "leaf" });
      };
      const lstatSync = fs.lstatSync;
      fs.lstatSync = (...args) => {
        const found = lstatSync(...args);
        if (fs.readFileSync(phase, "utf8") === "swap" && !fs.existsSync(made) && path.basename(process.cwd()) === "tree" && args[0] === "branch") {
          fs.writeFileSync(made, "");
          fs.rmSync("branch", { recursive: true });
          fs.symlinkSync(outside, "branch", "dir");
        }
        return found;
      };
    `);
    const bound = pathToFileURL(path.resolve("src/cache/bound.ts")).href;
    const script = `
      import childProcess from "node:child_process";
      import nodeFs, { promises } from "node:fs";
      import path from "node:path";
      const [temporary, phase, hook, swap, displace] = ${JSON.stringify([temporary, phase, hook, swap, displace])};
      const stat = promises.stat.bind(promises);
      promises.stat = async (target, ...rest) => {
        if (String(target).startsWith("/proc/self/fd/")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return await stat(target, ...rest);
      };
      const spawn = childProcess.spawn;
      childProcess.spawn = (command, args, ...rest) => spawn(command, ["--require", hook, ...args], ...rest);
      const { cacheFs, ensureCacheDir, withBoundCacheDir } = await import(${JSON.stringify(bound)});
      nodeFs.writeFileSync(phase, "fail");
      const first = path.join(temporary, "a");
      const identity = await ensureCacheDir(first);
      const failure = await withBoundCacheDir(first, identity, async () => {
        await cacheFs.mkdir(path.join(first, "tree", "branch"), { recursive: true });
        await cacheFs.writeFile(path.join(first, "tree", "branch", "leaf"), "x");
        return await cacheFs.rm(path.join(first, "tree"), { recursive: true }).then(() => "removed", (error) => error.code);
      });
      const [anchor] = (await promises.readdir(first)).filter((name) => name.startsWith(".osnova-bound-"));
      nodeFs.writeFileSync(phase, "swap");
      const again = swap ? await withBoundCacheDir(first, identity, async () => await cacheFs.rm(path.join(first, "tree"), { recursive: true }))
        .then(() => "removed", (error) => error.diagnostic?.code ?? error.code) : undefined;
      for (const name of displace ? ["b", "c", "d", "e"] : []) {
        const dir = path.join(temporary, name);
        await withBoundCacheDir(dir, await ensureCacheDir(dir), async () => await cacheFs.writeFile(path.join(dir, "file"), name));
      }
      process.stdout.write(JSON.stringify({ failure, again, anchor }));
    `;
    const reported = JSON.parse(execFileSync(process.execPath, ["--import", tsx, "--input-type=module", "-e", script], { encoding: "utf8" })) as { failure: unknown; again: unknown; anchor: string };
    return { ...reported, swapped: nodeFs.existsSync(made) };
  }

  // What a failed recursive rm of tree/branch/leaf leaves in place.
  const leftInPlace = { tree: "dir", [path.join("tree", "branch")]: "dir", [path.join("tree", "branch", "leaf")]: `file:${Buffer.from("x").toString("base64")}` };

  it("leaves in place what a failed recursive rm could not remove, and removes the empty anchor once more recent ones displace it", async () => {
    const temporary = await temporaryDir();
    const outside = path.join(temporary, "outside");
    await fs.mkdir(outside);
    const { failure, anchor, swapped } = await afterAFailedRemoval(temporary, outside, false, true);
    expect(failure).toBe("EACCES");
    expect(anchor).toMatch(anchorName);
    expect(swapped).toBe(false);
    expect(await contents(path.join(temporary, "a"))).toEqual(leftInPlace);
  });

  it("deletes nothing outside the cache when what a failed recursive rm left in place is swapped for a link to outside as it is removed again", async () => {
    const temporary = await temporaryDir();
    const outside = path.join(temporary, "outside");
    await fs.mkdir(path.join(outside, "inner"), { recursive: true });
    await fs.writeFile(path.join(outside, "leaf"), "outside");
    await fs.writeFile(path.join(outside, "inner", "leaf"), "outside");
    const before = await contents(outside);
    const { failure, again, swapped } = await afterAFailedRemoval(temporary, outside, true, true);
    expect(failure).toBe("EACCES");
    expect(swapped).toBe(true);
    expect(again).toBe("cache-changing");
    expect(await contents(outside)).toEqual(before);
    // The run that found the branch swapped drops its anchor and removes it, leaving the tree that holds the link.
    expect(await fs.readdir(path.join(temporary, "a"))).toEqual(["tree"]);
    expect((await fs.lstat(path.join(temporary, "a", "tree", "branch"))).isSymbolicLink()).toBe(true);
  });

  it("removes its anchor when the process exits after a failed recursive rm, which leaves in place what it could not remove", async () => {
    const temporary = await temporaryDir();
    const outside = path.join(temporary, "outside");
    await fs.mkdir(outside);
    const { failure } = await afterAFailedRemoval(temporary, outside, false, false);
    expect(failure).toBe("EACCES");
    expect(await contents(path.join(temporary, "a"))).toEqual(leftInPlace);
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
      await withBoundCacheDir(dir, identity, async () => {
        await cacheFs.mkdir(dir + "/tree/branch", { recursive: true });
        await cacheFs.rm(dir + "/tree", { recursive: true });
        await cacheFs.writeFile(dir + "/file", "x");
      });
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
    const retargeted = await retargetedInHelpers();
    retargeted.arm({ name: "writeFileSync", parent, elsewhere, starts: "file.tmp", restore: false });
    const outcome = await withBoundCacheDir(cacheDir, identity, async () => {
      const written = await cacheFs.writeFile(path.join(cacheDir, "file.tmp"), "bound").then(() => "written", (error: unknown) => error);
      const renamed = await cacheFs.rename(path.join(cacheDir, "file.tmp"), path.join(cacheDir, "file")).then(() => "renamed", (error: unknown) => error);
      return { written, renamed };
    });
    expect(retargeted.done()).toBe(true);
    expect(outcome.written).toMatchObject({ diagnostic: { code: "cache-changing" } });
    expect(outcome.renamed).toMatchObject({ diagnostic: { code: "cache-changing" } });
    await expect(fs.access(path.join(elsewhere, "cache", "file.tmp"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(elsewhere, "cache", "file"))).rejects.toMatchObject({ code: "ENOENT" });
    // The helper had begun the write in the cache directory, which it is in, so the write landed there.
    expect(await fs.readFile(path.join(`${parent}-saved`, "cache", "file.tmp"), "utf8")).toBe("bound");
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

  // Once armed, swaps the anchor of cacheDir for a link to inner, so that its .. names the directory holding inner, and
  // moves the anchor itself to moved. It does so once, as the first change through the anchor begins, whether this
  // process or a helper process makes it.
  async function anchorSwappedForLink(cacheDir: string, inner: string, moved: string): Promise<{ arm: () => void; swapped: () => boolean }> {
    const dir = await temporaryDir();
    const armed = path.join(dir, "armed");
    const made = path.join(dir, "swapped");
    const swap = `(fs) => {
      const [cacheDir, inner, moved, armed, made] = ${JSON.stringify([cacheDir, inner, moved, armed, made])};
      if (!fs.existsSync(armed) || fs.existsSync(made)) return;
      fs.writeFileSync(made, "");
      const anchor = cacheDir + "/" + fs.readdirSync(cacheDir).find((name) => /^\\.osnova-bound-/.test(name));
      fs.renameSync(anchor, moved);
      fs.symlinkSync(inner, anchor, "dir");
    }`;
    const hook = path.join(dir, "hook.cjs");
    await fs.writeFile(hook, `
      const fs = require("node:fs");
      const swap = ${swap};
      const unwrapped = { ...fs };
      for (const name of ["copyFileSync", "lstatSync", "mkdirSync", "renameSync", "rmSync", "rmdirSync", "unlinkSync", "writeFileSync"]) {
        fs[name] = (...args) => {
          swap(unwrapped);
          return unwrapped[name](...args);
        };
      }
    `);
    preloadedInHelpers(cacheDir, hook);
    const swapHere = (0, eval)(swap) as (api: typeof nodeFs) => void;
    for (const name of ["copyFile", "lstat", "mkdir", "rename", "rm", "rmdir", "unlink", "writeFile"] as const) {
      const original = fs[name].bind(fs) as (...args: unknown[]) => Promise<unknown>;
      vi.spyOn(fs, name).mockImplementation((async (...args: unknown[]) => {
        if (args.some((arg) => typeof arg === "string" && arg.includes(".osnova-bound-"))) swapHere(nodeFs);
        return await original(...args);
      }) as never);
    }
    return { arm: () => nodeFs.writeFileSync(armed, ""), swapped: () => nodeFs.existsSync(made) };
  }

  it.each([
    ...changes,
    ["recursive mkdir", async (cacheDir: string) => await cacheFs.mkdir(path.join(cacheDir, "entry", "made", "deeper"), { recursive: true })],
  ] as const)("changes nothing outside the cache when the anchor is swapped for a link to outside as a %s begins", async (_name, change) => {
    const { elsewhere, cacheDir, otherCacheDir } = await twinCaches();
    const inner = path.join(otherCacheDir, "inner");
    await fs.mkdir(inner);
    const moved = path.join(elsewhere, "moved");
    const identity = await ensureCacheDir(cacheDir);
    const ours = await contents(cacheDir);
    const others = await contents(elsewhere);
    const anchor = await anchorSwappedForLink(cacheDir, inner, moved);
    const outcome = await withBoundCacheDir(cacheDir, identity, async () => {
      anchor.arm();
      return await change(cacheDir).then(() => "changed", (error: unknown) => (error as { diagnostic?: { code?: string } }).diagnostic?.code ?? error);
    });
    vi.restoreAllMocks();
    expect(anchor.swapped()).toBe(true);
    expect(["changed", "cache-changing", "cache-unbindable"]).toContain(outcome);
    // The anchor moved out of the cache holds nothing, and nothing else outside the cache changed.
    expect(await contents(elsewhere)).toEqual({ ...others, moved: "dir" });
    // A change that succeeded changed the cache directory.
    const besidesTheLink = Object.fromEntries(Object.entries(await contents(cacheDir)).filter(([name]) => !anchorName.test(name)));
    if (outcome === "changed") expect(besidesTheLink).not.toEqual(ours);  });

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

  // Has every helper process started in the cache directory load hook first. A helper takes no NODE_OPTIONS, so the hook
  // is passed on its command line.
  function preloadedInHelpers(cacheDir: string, hook: string): void {
    const spawn = childProcess.spawn.bind(childProcess) as (...args: unknown[]) => unknown;
    vi.spyOn(childProcess, "spawn").mockImplementation(((...args: unknown[]) => {
      if ((args[2] as { cwd?: unknown } | undefined)?.cwd !== cacheDir) return spawn(...args);
      return spawn(args[0], ["--require", hook, ...(args[1] as string[])], ...args.slice(2));
    }) as never);
  }

  // Retargets the parent around the mkdir by which the helper process that makes an anchor makes it: from before the
  // call until after it, or from after the call on, so that what runs then resolves the cache path into the other
  // directory. A module the helper is told to load first wraps its mkdirSync.
  async function retargetedAroundTheAnchor(parent: string, elsewhere: string, window: "during the call" | "during and after the call" | "after the call"): Promise<() => boolean> {
    const dir = await temporaryDir();
    const made = path.join(dir, "made");
    const hook = path.join(dir, "hook.cjs");
    await fs.writeFile(hook, `
      const fs = require("node:fs");
      const path = require("node:path");
      const [parent, elsewhere, window, made] = ${JSON.stringify([parent, elsewhere, window, made])};
      const retarget = () => {
        fs.renameSync(parent, parent + "-saved");
        fs.symlinkSync(elsewhere, parent, "dir");
      };
      const restore = () => {
        if (!fs.lstatSync(parent).isSymbolicLink()) return;
        fs.unlinkSync(parent);
        fs.renameSync(parent + "-saved", parent);
      };
      const mkdirSync = fs.mkdirSync;
      fs.mkdirSync = (...args) => {
        if (!path.basename(String(args[0])).startsWith(".osnova-bound")) return mkdirSync(...args);
        fs.writeFileSync(made, "");
        if (window !== "after the call") retarget();
        try {
          return mkdirSync(...args);
        } finally {
          if (window === "during the call") restore();
          else if (window === "after the call") retarget();
        }
      };
    `);
    preloadedInHelpers(path.join(parent, "cache"), hook);
    return () => nodeFs.existsSync(made);
  }

  it("makes the anchor in the cache directory, and changes nothing in the other cache, when a parent is retargeted during the creation of the anchor and restored after it", async () => {
    const { parent, elsewhere, cacheDir, otherCacheDir } = await twinCaches();
    const ours = await contents(cacheDir);
    const others = await contents(otherCacheDir);
    const cwd = process.cwd();
    const retargeted = await retargetedAroundTheAnchor(parent, elsewhere, "during the call");
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
    const retargeted = await retargetedAroundTheAnchor(parent, elsewhere, "during and after the call");
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
    const retargeted = await retargetedAroundTheAnchor(parent, elsewhere, "after the call");
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
    // The helper process that makes the anchor enters the cache directory as it starts, and the parent is restored as
    // it exits.
    const spawn = childProcess.spawn.bind(childProcess) as (...args: unknown[]) => childProcess.ChildProcess;
    let retargeted = false;
    vi.spyOn(childProcess, "spawn").mockImplementation(((...args: unknown[]) => {
      if (retargeted || (args[2] as { cwd?: unknown } | undefined)?.cwd !== cacheDir) return spawn(...args);
      retargeted = true;
      retargetSync(parent, elsewhere);
      return spawn(...args).once("exit", () => restoreSync(parent));
    }) as never);
    const outcome = await anchoredWrite(cacheDir);
    vi.restoreAllMocks();
    expect(retargeted).toBe(true);
    expect(outcome).toMatchObject({ diagnostic: { phase: "cache", path: cacheDir, code: "cache-changing" } });
    expect(await contents(otherCacheDir)).toEqual(others);
    expect(await contents(cacheDir)).toEqual(ours);
    expect(process.cwd()).toBe(cwd);
  });

  // Runs check with the working directory at work, whose path Node has read, as any earlier caller reading it makes Node
  // keep, and enters the working directory the test started in again afterwards.
  async function workingIn<T>(work: string, check: (seen: string) => Promise<T>): Promise<T> {
    const original = process.cwd();
    process.chdir(work);
    try {
      expect(process.cwd()).toBe(work);
      return await check(identityOf(nodeFs.statSync(".", { bigint: true })));
    } finally {
      process.chdir(original);
    }
  }

  it("leaves the caller in its working directory when a parent of that directory is retargeted during the creation of the anchor", async () => {
    const temporary = await temporaryDir();
    const cacheDir = path.join(temporary, "cache");
    const parent = path.join(temporary, "w");
    const elsewhere = path.join(temporary, "x");
    const work = path.join(parent, "work");
    await fs.mkdir(work, { recursive: true });
    await fs.mkdir(path.join(elsewhere, "work"), { recursive: true });
    const identity = await ensureCacheDir(cacheDir);
    const { retargeted, outcome, seen, after } = await workingIn(work, async (seen) => {
      let retargeted = false;
      afterStat(cacheDir, () => true, async () => {
        await retarget(parent, elsewhere);
        retargeted = true;
      });
      const outcome = await withBoundCacheDir(cacheDir, identity, async () => await cacheFs.writeFile(path.join(cacheDir, "file"), "x"))
        .then(() => "written", (error: unknown) => error);
      const after = identityOf(nodeFs.statSync(".", { bigint: true }));
      vi.restoreAllMocks();
      await restore(parent);
      return { retargeted, outcome, seen, after };
    });
    expect(retargeted).toBe(true);
    expect(outcome).toBe("written");
    expect(after).toBe(seen);
    expect(await besidesItsAnchor(cacheDir)).toEqual({ file: `file:${Buffer.from("x").toString("base64")}` });
  });

  it("leaves the caller in its working directory when that directory is removed during the creation of the anchor", async () => {
    const temporary = await temporaryDir();
    const cacheDir = path.join(temporary, "cache");
    const work = path.join(temporary, "work");
    await fs.mkdir(work);
    const identity = await ensureCacheDir(cacheDir);
    const { removed, outcome, seen, after } = await workingIn(work, async (seen) => {
      let removed = false;
      afterStat(cacheDir, () => true, async () => {
        await fs.rmdir(work);
        removed = true;
      });
      const outcome = await withBoundCacheDir(cacheDir, identity, async () => await cacheFs.writeFile(path.join(cacheDir, "file"), "x"))
        .then(() => "written", (error: unknown) => error);
      const after = identityOf(nodeFs.statSync(".", { bigint: true }));
      vi.restoreAllMocks();
      return { removed, outcome, seen, after };
    });
    expect(removed).toBe(true);
    expect(outcome).toBe("written");
    expect(after).toBe(seen);
    expect(await besidesItsAnchor(cacheDir)).toEqual({ file: `file:${Buffer.from("x").toString("base64")}` });
  });

  it("makes the anchor while NODE_OPTIONS preloads a module by a path relative to the caller's working directory", async () => {
    const temporary = await temporaryDir();
    const cacheDir = path.join(temporary, "cache");
    const work = path.join(temporary, "work");
    await fs.mkdir(work);
    await fs.writeFile(path.join(work, "hook.cjs"), "");
    vi.stubEnv("NODE_OPTIONS", `${process.env.NODE_OPTIONS ?? ""} --require ./hook.cjs`);
    const identity = await ensureCacheDir(cacheDir);
    const outcome = await workingIn(work, async () => await withBoundCacheDir(cacheDir, identity, async () => await cacheFs.writeFile(path.join(cacheDir, "file"), "x"))
      .then(() => "written", (error: unknown) => error));
    expect(outcome).toBe("written");
    expect(await besidesItsAnchor(cacheDir)).toEqual({ file: `file:${Buffer.from("x").toString("base64")}` });
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

  // Retargets the parent around the lstat by which the helper of the anchor finds the tree a recursive rm removes, or as
  // that lstat returns, so that the cache path then resolves into the other directory.
  async function retargetedAroundTheTreeLstat(cacheDir: string, parent: string, elsewhere: string, window: "during the call" | "after the call"): Promise<() => boolean> {
    const dir = await temporaryDir();
    const made = path.join(dir, "retargeted");
    const hook = path.join(dir, "hook.cjs");
    await fs.writeFile(hook, `
      const fs = require("node:fs");
      const path = require("node:path");
      const [parent, elsewhere, window, made] = ${JSON.stringify([parent, elsewhere, window, made])};
      const retarget = () => {
        fs.renameSync(parent, parent + "-saved");
        fs.symlinkSync(elsewhere, parent, "dir");
      };
      const restore = () => {
        if (!fs.lstatSync(parent).isSymbolicLink()) return;
        fs.unlinkSync(parent);
        fs.renameSync(parent + "-saved", parent);
      };
      const lstatSync = fs.lstatSync;
      fs.lstatSync = (...args) => {
        if (fs.existsSync(made) || String(args[0]) !== "tree") return lstatSync(...args);
        fs.writeFileSync(made, "");
        if (window === "during the call") retarget();
        try {
          return lstatSync(...args);
        } finally {
          if (window === "during the call") restore();
          else retarget();
        }
      };
    `);
    preloadedInHelpers(cacheDir, hook);
    return () => nodeFs.existsSync(made);
  }

  // The helper of the anchor is in the cache directory, so the cache path it no longer resolves cannot send it elsewhere.
  it("removes the tree from the cache directory, and changes nothing in the other cache, when a parent is retargeted as the helper finds the tree a recursive rm removes and restored after it", async () => {
    const { parent, elsewhere, cacheDir, otherCacheDir } = await twinCaches();
    const identity = await ensureCacheDir(cacheDir);
    const ours = await contents(cacheDir);
    const others = await contents(otherCacheDir);
    const retargeted = await retargetedAroundTheTreeLstat(cacheDir, parent, elsewhere, "during the call");
    const outcome = await withBoundCacheDir(cacheDir, identity, async () => await cacheFs.rm(path.join(cacheDir, "tree"), { recursive: true, force: true }))
      .then(() => "removed", (error: unknown) => error);
    vi.restoreAllMocks();
    expect(retargeted()).toBe(true);
    expect(outcome).toBe("removed");
    expect(await contents(otherCacheDir)).toEqual(others);
    expect(await besidesItsAnchor(cacheDir)).toEqual(Object.fromEntries(Object.entries(ours).filter(([name]) => name.split(path.sep)[0] !== "tree")));
  });

  // Restores the parent as the next check of the cache directory, after the change, begins.
  function restoredAsTheCheckAfterBegins(cacheDir: string, parent: string, retargeted: () => boolean): () => boolean {
    const stat = vi.mocked(fs.stat).getMockImplementation() as (...args: unknown[]) => Promise<unknown>;
    let restored = false;
    vi.spyOn(fs, "stat").mockImplementation((async (...args: unknown[]) => {
      if (args[0] === cacheDir && retargeted() && !restored) {
        await restore(parent);
        restored = true;
      }
      return await stat(...args);
    }) as never);
    return () => restored;
  }

  // Node's rm takes a path it finds missing once it has found its target as removed; the helper's rm finds its target,
  // and deletes it, in the directory it is in, so it deletes nothing elsewhere.
  it("deletes the file from the cache directory, and changes nothing in the other cache, when a parent is retargeted as an ordinary rm begins and restored before it returns", async () => {
    const { parent, elsewhere, cacheDir, otherCacheDir } = await twinCaches();
    const identity = await ensureCacheDir(cacheDir);
    const ours = await contents(cacheDir);
    const others = await contents(otherCacheDir);
    const retargeted = await retargetedInHelpers();
    const restored = restoredAsTheCheckAfterBegins(cacheDir, parent, retargeted.done);
    retargeted.arm({ name: "rmSync", parent, elsewhere, within: "entry", starts: "file", restore: false });
    const outcome = await withBoundCacheDir(cacheDir, identity, async () => await cacheFs.rm(path.join(cacheDir, "entry", "file"), { force: true }))
      .then(() => "removed", (error: unknown) => error);
    vi.restoreAllMocks();
    await restore(parent);
    expect(retargeted.done()).toBe(true);
    expect(restored()).toBe(true);
    expect(outcome).toBe("removed");
    expect(await contents(otherCacheDir)).toEqual(others);
    expect(await besidesItsAnchor(cacheDir)).toEqual(Object.fromEntries(Object.entries(ours).filter(([name]) => name !== path.join("entry", "file"))));
  });

  it("removes the tree from the cache directory, and changes nothing in the other cache, when a parent is retargeted after the helper finds the tree a recursive rm removes and restored before it returns", async () => {
    const { parent, elsewhere, cacheDir, otherCacheDir } = await twinCaches();
    const identity = await ensureCacheDir(cacheDir);
    const ours = await contents(cacheDir);
    const others = await contents(otherCacheDir);
    const retargeted = await retargetedAroundTheTreeLstat(cacheDir, parent, elsewhere, "after the call");
    const restored = restoredAsTheCheckAfterBegins(cacheDir, parent, retargeted);
    const outcome = await withBoundCacheDir(cacheDir, identity, async () => await cacheFs.rm(path.join(cacheDir, "tree"), { recursive: true, force: true }))
      .then(() => "removed", (error: unknown) => error);
    vi.restoreAllMocks();
    await restore(parent);
    expect(retargeted()).toBe(true);
    expect(restored()).toBe(true);
    expect(outcome).toBe("removed");
    expect(await contents(otherCacheDir)).toEqual(others);
    expect(await besidesItsAnchor(cacheDir)).toEqual(Object.fromEntries(Object.entries(ours).filter(([name]) => name.split(path.sep)[0] !== "tree")));
  });

  // Swaps the branch of a tree a recursive rm removes for a symbolic link to outside, once, as the helper's listing of
  // that tree settles, or as its examination of the branch settles.
  async function branchSwappedForLink(cacheDir: string, outside: string, window: "after the listing" | "after the branch is examined"): Promise<() => boolean> {
    const dir = await temporaryDir();
    const made = path.join(dir, "swapped");
    const hook = path.join(dir, "hook.cjs");
    await fs.writeFile(hook, `
      const fs = require("node:fs");
      const path = require("node:path");
      const [outside, window, made] = ${JSON.stringify([outside, window, made])};
      const inTree = () => path.basename(process.cwd()) === "tree";
      const swap = () => {
        fs.writeFileSync(made, "");
        fs.rmSync("branch", { recursive: true });
        fs.symlinkSync(outside, "branch", "dir");
      };
      const readdirSync = fs.readdirSync;
      fs.readdirSync = (...args) => {
        const listed = readdirSync(...args);
        if (window === "after the listing" && !fs.existsSync(made) && inTree() && listed.map(String).includes("branch")) swap();
        return listed;
      };
      const lstatSync = fs.lstatSync;
      fs.lstatSync = (...args) => {
        const found = lstatSync(...args);
        if (window === "after the branch is examined" && !fs.existsSync(made) && inTree() && args[0] === "branch") swap();
        return found;
      };
    `);
    preloadedInHelpers(cacheDir, hook);
    return () => nodeFs.existsSync(made);
  }

  it.each([
    ["after the listing", "removed"],
    ["after the branch is examined", "cache-changing"],
  ] as const)("deletes nothing outside the cache when the branch of a tree a recursive rm removes is swapped for a link to outside %s", async (window, expected) => {
    const temporary = await temporaryDir();
    const cacheDir = path.join(temporary, "cache");
    const outside = path.join(temporary, "outside");
    await fs.mkdir(path.join(outside, "inner"), { recursive: true });
    await fs.writeFile(path.join(outside, "leaf"), "outside");
    await fs.writeFile(path.join(outside, "inner", "leaf"), "outside");
    const before = await contents(outside);
    const identity = await ensureCacheDir(cacheDir);
    const swapped = await branchSwappedForLink(cacheDir, outside, window);
    const outcome = await withBoundCacheDir(cacheDir, identity, async () => {
      await cacheFs.mkdir(path.join(cacheDir, "tree", "branch"), { recursive: true });
      await cacheFs.writeFile(path.join(cacheDir, "tree", "branch", "leaf"), "x");
      return await cacheFs.rm(path.join(cacheDir, "tree"), { recursive: true, force: true }).then(() => "removed", (error: unknown) => error);
    });
    vi.restoreAllMocks();
    expect(swapped()).toBe(true);
    expect(await contents(outside)).toEqual(before);
    if (expected === "removed") {
      expect(outcome).toBe("removed");
      expect(await besidesItsAnchor(cacheDir)).toEqual({});
    } else {
      expect(outcome).toMatchObject({ diagnostic: { phase: "cache", path: cacheDir, code: expected } });
    }
    // The next run removes a tree again, by a helper in the cache directory.
    const again = await withBoundCacheDir(cacheDir, identity, async () => {
      await cacheFs.mkdir(path.join(cacheDir, "again", "branch"), { recursive: true });
      await cacheFs.writeFile(path.join(cacheDir, "again", "branch", "leaf"), "x");
      return await cacheFs.rm(path.join(cacheDir, "again"), { recursive: true }).then(() => "removed", (error: unknown) => error);
    });
    expect(again).toBe("removed");
    expect(await contents(outside)).toEqual(before);
    expect(Object.keys(await contents(cacheDir)).filter((name) => name.split(path.sep)[0] === "again")).toEqual([]);
  });

  it("names the requested path, not the helper's, in the error of a recursive rm that fails within its tree", async () => {
    const temporary = await temporaryDir();
    const cacheDir = path.join(temporary, "cache");
    const identity = await ensureCacheDir(cacheDir);
    // The helper of the anchor removes the tree, and fails the unlink or rmdir of the path within the cache directory the
    // file failing names.
    const dir = await temporaryDir();
    const failingFile = path.join(dir, "failing");
    const hook = path.join(dir, "hook.cjs");
    await fs.writeFile(hook, `
      const fs = require("node:fs");
      const path = require("node:path");
      const [cacheDir, failingFile] = ${JSON.stringify([cacheDir, failingFile])};
      for (const name of ["unlink", "rmdir"]) {
        const original = fs[name + "Sync"];
        fs[name + "Sync"] = (...args) => {
          const target = String(args[0]);
          if (path.relative(cacheDir, path.join(process.cwd(), target)) !== fs.readFileSync(failingFile, "utf8")) return original(...args);
          throw Object.assign(new Error("EACCES: permission denied, " + name + " '" + target + "'"), { code: "EACCES", errno: -13, syscall: name, path: target });
        };
      }
    `);
    preloadedInHelpers(cacheDir, hook);
    const outcomes = await withBoundCacheDir(cacheDir, identity, async () => {
      await cacheFs.mkdir(path.join(cacheDir, "tree", "branch"), { recursive: true });
      await cacheFs.writeFile(path.join(cacheDir, "tree", "branch", "leaf"), "x");
      await cacheFs.mkdir(path.join(cacheDir, "other"));
      const settle = async (target: string, inside: string): Promise<unknown> => {
        await fs.writeFile(failingFile, inside);
        return await cacheFs.rm(target, { recursive: true }).then(() => "removed", (error: unknown) => {
          const failure = error as NodeJS.ErrnoException;
          return { code: failure.code, path: failure.path, message: failure.message };
        });
      };
      return [await settle(path.join(cacheDir, "tree"), path.join("tree", "branch", "leaf")), await settle(path.join(cacheDir, "other"), "other")];
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

  it("writes a string in the encoding its options name, and bytes as given", async () => {
    const temporary = await temporaryDir();
    const cacheDir = path.join(temporary, "cache");
    const identity = await ensureCacheDir(cacheDir);
    await withBoundCacheDir(cacheDir, identity, async () => {
      await cacheFs.writeFile(path.join(cacheDir, "named"), "é", "latin1");
      await cacheFs.writeFile(path.join(cacheDir, "optioned"), "6869", { encoding: "hex" });
      await cacheFs.writeFile(path.join(cacheDir, "bytes"), new Uint8Array([1, 2, 3]).subarray(1));
    });
    expect([...await fs.readFile(path.join(cacheDir, "named"))]).toEqual([0xe9]);
    expect(await fs.readFile(path.join(cacheDir, "optioned"), "utf8")).toBe("hi");
    expect([...await fs.readFile(path.join(cacheDir, "bytes"))]).toEqual([2, 3]);
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

  // Calls published once the refresh has published the verification of its index.
  function afterPublication(published: () => void): void {
    const rename = cacheFs.rename as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(cacheFs, "rename").mockImplementation((async (...args: unknown[]) => {
      const result = await rename(...args);
      if (path.basename(String(args[1])) === "index.sha") published();
      return result;
    }) as never);
  }

  it("writes nothing into the retargeted cache when a parent is retargeted after the root check before the verification is published", async () => {
    const { parent, elsewhere, root, cacheDir, otherCacheDir } = await sharedParent();
    const otherEntries = (await fs.readdir(otherCacheDir)).sort();
    let published = false;
    let retargeted = false;
    afterPublication(() => { published = true; });
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

  // The helper of the anchor is in the cache directory, so a change it has begun when a parent is retargeted, and
  // finished when the parent is restored, lands there, and neither check sees the retarget. The helpers are started as
  // the caches are set up, so the hook is in place first.
  it.each([
    ["the write of an artifact it publishes", "writeFileSync", "key", "index.json.tmp-", {}],
    ["the deletion of an evicted entry", "rmSync", "olderKey", "index.json", { maxWorkspaces: 1 }],
  ] as const)("completes the refresh in the cache directory, and changes nothing in the retargeted cache, when a parent is retargeted during %s and restored before it returns", async (_name, name, within, starts, limits) => {
    const retargeted = await retargetedInHelpers();
    const entries = await sharedEntries();
    const { parent, elsewhere, root, cacheDir, otherCacheDir } = entries;
    const others = await contents(otherCacheDir);
    retargeted.arm({ name, parent, elsewhere, within: entries[within], starts, restore: true });
    const outcome = await refreshWorkspaceWitnessed(root, { cacheDir, ...limits });
    vi.restoreAllMocks();
    await restore(parent);
    expect(retargeted.done()).toBe(true);
    expect(names(outcome.index)).toEqual(expect.arrayContaining(["onlyInP", "addedInP"]));
    expect(await contents(otherCacheDir)).toEqual(others);
    expect(names((await refreshWorkspaceWitnessed(root, { cacheDir })).index)).toEqual(expect.arrayContaining(["onlyInP", "addedInP"]));
  });

  // The helper of the anchor is in the cache directory, so the one change it has begun when the parent is retargeted
  // lands there. The check after it fails the refresh, so nothing more is written and nothing is published in the
  // retargeted cache.
  it("fails the refresh, and publishes nothing into the retargeted cache, when a parent is retargeted during a cache write", async () => {
    const retargeted = await retargetedInHelpers();
    const { parent, elsewhere, root, cacheDir, otherCacheDir, key } = await sharedParent();
    afterPublication(() => retargeted.arm({ name: "mkdirSync", parent, elsewhere, starts: key, restore: false }));
    restoredAfterTheNextCheck(cacheDir, parent, retargeted.done);
    const outcome = await refreshWorkspaceWitnessed(root, { cacheDir }).then((answer) => answer, (error: unknown) => error);
    vi.restoreAllMocks();
    await restore(parent);
    expect(retargeted.done()).toBe(true);
    expect(outcome).toMatchObject({ diagnostic: { phase: "cache", path: cacheDir, code: "cache-changing" } });
    expect(await fs.readdir(path.join(otherCacheDir, key)).catch(() => [])).toEqual([]);
    expect(names((await refreshWorkspaceWitnessed(root, { cacheDir })).index)).toEqual(expect.arrayContaining(["onlyInP", "addedInP"]));
  });
});

const names = (index: { symbols: ReadonlyMap<string, { name: string }> }): string[] => [...index.symbols.values()].map((symbol) => symbol.name);
