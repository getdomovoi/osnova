import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs, realpathSync, renameSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { refreshWorkspaceWitnessed } from "../src/api.js";
import { cacheFs } from "../src/cache/bound.js";
import { workspaceDirFor, workspaceLockPath } from "../src/cache/cache.js";
import { scanSerial } from "../src/index/scan.js";
import { reachedPath } from "./reached-path.js";

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of closers.splice(0).reverse()) await close(); });

async function temporaryDir(): Promise<string> {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "osnova-refresh-root-")));
  closers.push(() => fs.rm(temporary, { recursive: true, force: true }));
  return temporary;
}

async function plantLiveLock(lockPath: string): Promise<void> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  closers.push(() => { child.kill(); });
  await fs.mkdir(lockPath);
  await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ pid: child.pid!, host: os.hostname(), token: randomUUID() }));
}

// Runs once, during the first call of fs.realpath on the given path that the condition accepts, then lets the call
// proceed with what the path names after the interlude. afterwards, if given, runs once that call has settled and
// before its caller sees the result.
function duringRealpath(target: string, accept: () => boolean, interlude: () => Promise<void>, afterwards?: () => Promise<void>): void {
  const original = fs.realpath.bind(fs) as (...args: unknown[]) => Promise<unknown>;
  let pending = true;
  vi.spyOn(fs, "realpath").mockImplementation((async (...args: unknown[]) => {
    if (!pending || path.resolve(String(args[0])) !== target || !accept()) return await original(...args);
    pending = false;
    await interlude();
    const settled = await original(...args).then((value) => ({ value }), (error: unknown) => ({ error }));
    await afterwards?.();
    if ("error" in settled) throw settled.error;
    return settled.value;
  }) as never);
}

// A change within the cache directory is intercepted on cacheFs, which every platform calls first: where no descriptor
// binds the cache directory, as on macOS, a helper process makes the change and the promise API never sees it. A read
// is made by this process everywhere, so it is intercepted on the promise API.
const intercepted = (method: "readFile" | "rename") => method === "rename" ? cacheFs : fs;

// Resolves when cacheFs.rename is first called with the given path as its destination.
function renamedOnto(target: string): Promise<void> {
  const original = cacheFs.rename.bind(cacheFs) as (...args: unknown[]) => Promise<unknown>;
  return new Promise((resolve) => {
    vi.spyOn(cacheFs, "rename").mockImplementation((async (...args: unknown[]) => {
      if (reachedPath(String(args[1])) === target) resolve();
      return await original(...args);
    }) as never);
  });
}

// Runs before, then the first call of method whose path (the destination, for rename) the condition accepts, then
// after, once that call has settled and before its caller sees the result.
function aroundFirst(method: "readFile" | "rename", accept: (file: string) => boolean, before: () => Promise<void>, after?: () => Promise<void>): void {
  const api = intercepted(method);
  const original = api[method].bind(api) as (...args: unknown[]) => Promise<unknown>;
  const at = method === "rename" ? 1 : 0;
  let pending = true;
  vi.spyOn(api, method).mockImplementation((async (...args: unknown[]) => {
    if (!pending || typeof args[at] !== "string" || !accept(reachedPath(args[at]))) return await original(...args);
    pending = false;
    await before();
    const settled = await original(...args).then((value) => ({ value }), (error: unknown) => ({ error }));
    await after?.();
    if ("error" in settled) throw settled.error;
    return settled.value;
  }) as never);
}

// A parent directory p holding the root, and a directory q holding a root of the same name with other sources.
async function parentAndElsewhere(): Promise<{ parent: string; elsewhere: string; root: string; other: string; cacheDir: string }> {
  const temporary = await temporaryDir();
  const parent = path.join(temporary, "p");
  const elsewhere = path.join(temporary, "q");
  const root = path.join(parent, "root");
  const other = path.join(elsewhere, "root");
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(other, { recursive: true });
  await fs.writeFile(path.join(root, "a.ts"), "export function onlyInP() { return 1; }\n");
  await fs.writeFile(path.join(other, "a.ts"), "export function onlyInQ() { return 2; }\n");
  return { parent, elsewhere, root, other, cacheDir: path.join(temporary, "cache") };
}

// Exchanges two ordinary directories, so every path stays the same and names the other directory's contents.
async function swapDirectories(a: string, b: string): Promise<void> {
  await fs.rename(a, `${a}-swap`);
  await fs.rename(b, a);
  await fs.rename(`${a}-swap`, b);
}

async function retargetToSymlink(parent: string, elsewhere: string): Promise<void> {
  await fs.rename(parent, `${parent}-saved`);
  await fs.symlink(elsewhere, parent, "dir");
}

async function restoreFromSymlink(parent: string): Promise<void> {
  if (!(await fs.lstat(parent)).isSymbolicLink()) return;
  await fs.unlink(parent);
  await fs.rename(`${parent}-saved`, parent);
}

const names = (index: { symbols: ReadonlyMap<string, { name: string }> }): string[] => [...index.symbols.values()].map((symbol) => symbol.name);

describe("refreshWorkspaceWitnessed and the root it captured", () => {
  // The refresh resolved A, then A became a symlink to B before the lock path was taken, so a lock derived from the
  // path again would be B's, held here by another owner. Once A is restored, a request for A must not join a refresh
  // that waits on B's lock.
  it("does not lock another root, or let a later request inherit its wait, when the canonical directory is retargeted and restored during setup", async () => {
    const temporary = await temporaryDir();
    const rootA = path.join(temporary, "a");
    const rootB = path.join(temporary, "b");
    await fs.mkdir(rootA);
    await fs.mkdir(rootB);
    await fs.writeFile(path.join(rootA, "a.ts"), "export function onlyInA() { return 1; }\n");
    await fs.writeFile(path.join(rootB, "b.ts"), "export function onlyInB() { return 2; }\n");
    const cacheDir = path.join(temporary, "cache");
    await fs.mkdir(cacheDir);
    const lockB = workspaceLockPath(cacheDir, rootB);
    await plantLiveLock(lockB);
    const options = { cacheDir, lockTimeoutMs: 2_000 };
    const waitingOnB = renamedOnto(lockB);
    duringRealpath(cacheDir, () => true, async () => {
      await fs.rename(rootA, `${rootA}-saved`);
      await fs.symlink(rootB, rootA, "dir");
    });
    const first = refreshWorkspaceWitnessed(rootA, options).then(() => "answered", (error: unknown) => error);
    await Promise.race([waitingOnB, first]);
    await fs.unlink(rootA);
    await fs.rename(`${rootA}-saved`, rootA);
    const second = await refreshWorkspaceWitnessed(rootA, options);
    expect(second.witness.root).toBe(rootA);
    expect(names(second.index)).toContain("onlyInA");
    expect(await first).toMatchObject({ diagnostic: { code: "workspace-changing" } });
  });

  // The root was checked once the lock was taken, but the scan resolves it again, and a parent directory that became
  // a symlink in between makes the same path name another directory, whose lock the refresh does not hold. The parent
  // is restored as soon as the scan has resolved the root, so later checks of the path find nothing amiss.
  it("fails instead of answering from another directory's scan when a parent is a symlink only while the scan resolves the root", async () => {
    const temporary = await temporaryDir();
    const parent = path.join(temporary, "p");
    const elsewhere = path.join(temporary, "q");
    const root = path.join(parent, "root");
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(path.join(elsewhere, "root"), { recursive: true });
    await fs.writeFile(path.join(root, "a.ts"), "export function onlyInP() { return 1; }\n");
    await fs.writeFile(path.join(elsewhere, "root", "a.ts"), "export function onlyInQ() { return 2; }\n");
    const cacheDir = path.join(temporary, "cache");
    expect(names((await refreshWorkspaceWitnessed(root, { cacheDir })).index)).toContain("onlyInP");
    const before = scanSerial();
    duringRealpath(root, () => scanSerial() > before, async () => {
      await fs.rename(parent, `${parent}-saved`);
      await fs.symlink(elsewhere, parent, "dir");
    }, async () => {
      await fs.unlink(parent);
      await fs.rename(`${parent}-saved`, parent);
    });
    await expect(refreshWorkspaceWitnessed(root, { cacheDir })).rejects.toMatchObject({ diagnostic: { code: "workspace-changing" } });
  });

  // The scan resolved the locked root, then a parent directory became a symlink as the cached index is read, so building
  // an index, or inspecting the loaded one, reads the same path from another directory. Restoring the parent afterwards
  // must not leave a witness of the locked root's scan paired with the other directory's index. The source is newer
  // than the verification, so the refresh reads it after the scan; building follows a cached index that fails its
  // checksum.
  it.each([
    ["loads", true],
    ["builds", false],
  ])("fails instead of answering with another directory's index when a parent is retargeted after the scan and the refresh %s it", async (_, otherCached) => {
    const temporary = await temporaryDir();
    const parent = path.join(temporary, "p");
    const elsewhere = path.join(temporary, "q");
    const root = path.join(parent, "root");
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(path.join(elsewhere, "root"), { recursive: true });
    await fs.writeFile(path.join(root, "a.ts"), "export function onlyInP() { return 1; }\n");
    await fs.writeFile(path.join(elsewhere, "root", "a.ts"), "export function onlyInQ() { return 2; }\n");
    const cacheDir = path.join(temporary, "cache");
    expect(names((await refreshWorkspaceWitnessed(root, { cacheDir })).index)).toContain("onlyInP");
    if (otherCached) expect(names((await refreshWorkspaceWitnessed(path.join(elsewhere, "root"), { cacheDir })).index)).toContain("onlyInQ");
    await fs.utimes(path.join(root, "a.ts"), new Date(2_000_000_000_000), new Date(2_000_000_000_000));
    const own = workspaceDirFor(cacheDir, root);
    if (!otherCached) await fs.writeFile(path.join(own, "index.sha"), `${"0".repeat(64)}\n`);
    const before = scanSerial();
    let retargeted = false;
    const retarget = (): void => {
      if (retargeted) return;
      retargeted = true;
      renameSync(parent, `${parent}-saved`);
      symlinkSync(elsewhere, parent, "dir");
    };
    const original = realpathSync.native;
    vi.spyOn(realpathSync, "native").mockImplementation(((...args: Parameters<typeof original>) => {
      if (scanSerial() > before && path.resolve(String(args[0])) === root) retarget();
      return original(...args);
    }) as typeof original);
    aroundFirst("readFile", (file) => scanSerial() > before && file === path.join(own, "index.json"), async () => { retarget(); });
    const outcome = await refreshWorkspaceWitnessed(root, { cacheDir }).then(
      (answer) => names(answer.index),
      (error: unknown) => error,
    );
    vi.restoreAllMocks();
    expect(retargeted).toBe(true);
    await fs.unlink(parent);
    await fs.rename(`${parent}-saved`, parent);
    expect(outcome).toMatchObject({ diagnostic: { code: "workspace-changing" } });
    const after = await refreshWorkspaceWitnessed(root, { cacheDir });
    expect(after.witness.root).toBe(root);
    expect(names(after.index)).toContain("onlyInP");
    expect(names(after.index)).not.toContain("onlyInQ");
  });

  // The scan resolved the locked root, then a parent became a symlink as the cached index loads. Loading must name the
  // locked root's entry and lock, never the other root's: waiting on that root's lock, held here by another owner, or
  // recording a reader in its entry, would act for a workspace this refresh did not lock. The scan verified the cached
  // index unchanged before the retarget, so that index is the answer.
  it.each([
    ["held by another owner", true],
    ["free", false],
  ])("loads only the locked root's entry when a parent is retargeted after the scan and the other root's lock is %s", async (_, otherLocked) => {
    const { parent, elsewhere, root, other, cacheDir } = await parentAndElsewhere();
    expect(names((await refreshWorkspaceWitnessed(root, { cacheDir })).index)).toContain("onlyInP");
    expect(names((await refreshWorkspaceWitnessed(other, { cacheDir })).index)).toContain("onlyInQ");
    const otherAccess = path.join(workspaceDirFor(cacheDir, other), "access");
    const accessBefore = await fs.readFile(otherAccess, "utf8");
    const otherLock = workspaceLockPath(cacheDir, other);
    if (otherLocked) await plantLiveLock(otherLock);
    const ownerBefore = otherLocked ? await fs.readFile(path.join(otherLock, "owner.json"), "utf8") : undefined;
    const ownIndex = path.join(workspaceDirFor(cacheDir, root), "index.json");
    const before = scanSerial();
    let retargeted = false;
    const retarget = (): void => {
      if (retargeted) return;
      retargeted = true;
      renameSync(parent, `${parent}-saved`);
      symlinkSync(elsewhere, parent, "dir");
    };
    const original = realpathSync.native;
    vi.spyOn(realpathSync, "native").mockImplementation(((...args: Parameters<typeof original>) => {
      if (scanSerial() > before && path.resolve(String(args[0])) === root) retarget();
      return original(...args);
    }) as typeof original);
    aroundFirst("readFile", (file) => scanSerial() > before && file === ownIndex, async () => { retarget(); });
    const started = performance.now();
    const outcome = await refreshWorkspaceWitnessed(root, { cacheDir, lockTimeoutMs: 1_500 }).then((answer) => names(answer.index), (error: unknown) => error);
    const elapsed = performance.now() - started;
    vi.restoreAllMocks();
    expect(retargeted).toBe(true);
    await restoreFromSymlink(parent);
    expect(outcome).toEqual(["onlyInP"]);
    expect(elapsed).toBeLessThan(1_000);
    expect(await fs.readFile(otherAccess, "utf8")).toBe(accessBefore);
    if (otherLocked) expect(await fs.readFile(path.join(otherLock, "owner.json"), "utf8")).toBe(ownerBefore);
    const after = await refreshWorkspaceWitnessed(root, { cacheDir });
    expect(after.witness.root).toBe(root);
    expect(names(after.index)).toContain("onlyInP");
  });

  // Inspection read the locked root's source, then a parent became a symlink to a directory with the same sources, so
  // the hashes match and nothing is stale. Writing the verification now would resolve the path to the other directory.
  it("fails before writing anything when a parent is retargeted while the refresh inspects the files", async () => {
    const temporary = await temporaryDir();
    const parent = path.join(temporary, "p");
    const elsewhere = path.join(temporary, "q");
    const root = path.join(parent, "root");
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(path.join(elsewhere, "root"), { recursive: true });
    await fs.writeFile(path.join(root, "a.ts"), "export function shared() { return 1; }\n");
    await fs.writeFile(path.join(elsewhere, "root", "a.ts"), "export function shared() { return 1; }\n");
    const cacheDir = path.join(temporary, "cache");
    expect(names((await refreshWorkspaceWitnessed(root, { cacheDir })).index)).toContain("shared");
    await fs.utimes(path.join(root, "a.ts"), new Date(2_000_000_000_000), new Date(2_000_000_000_000));
    aroundFirst("readFile", (file) => file === path.join(root, "a.ts"), async () => {}, () => retargetToSymlink(parent, elsewhere));
    const outcome = await refreshWorkspaceWitnessed(root, { cacheDir }).then(() => "answered", (error: unknown) => error);
    vi.restoreAllMocks();
    const otherCache = workspaceDirFor(cacheDir, path.join(elsewhere, "root"));
    await fs.unlink(parent);
    await fs.rename(`${parent}-saved`, parent);
    expect(outcome).toMatchObject({ diagnostic: { code: "workspace-changing" } });
    await expect(fs.access(otherCache)).rejects.toMatchObject({ code: "ENOENT" });
    const after = await refreshWorkspaceWitnessed(root, { cacheDir });
    expect(after.witness.root).toBe(root);
    expect(names(after.index)).toContain("shared");
  });

  // A parent exchanged with another ordinary directory leaves every path the same, so only the root directory's
  // device and inode tell the two apart. Once the parent is restored, the locked root's witness holds again and must
  // not vouch for an index of the other directory's sources.
  it.each([
    ["while the scan resolves the root", "scan"],
    ["while the cached index loads", "load"],
    ["while the refresh reads a source", "inspect"],
  ] as const)("fails instead of answering with another directory's sources when a parent is exchanged with an ordinary directory %s", async (_, moment) => {
    const { parent, elsewhere, root, cacheDir } = await parentAndElsewhere();
    expect(names((await refreshWorkspaceWitnessed(root, { cacheDir })).index)).toContain("onlyInP");
    await fs.utimes(path.join(root, "a.ts"), new Date(2_000_000_000_000), new Date(2_000_000_000_000));
    let swapped = false;
    const swap = async (): Promise<void> => { await swapDirectories(parent, elsewhere); swapped = true; };
    if (moment === "scan") {
      const before = scanSerial();
      duringRealpath(root, () => scanSerial() > before, swap);
    } else {
      const file = moment === "load" ? path.join(workspaceDirFor(cacheDir, root), "index.json") : path.join(root, "a.ts");
      aroundFirst("readFile", (read) => read === file, swap);
    }
    const outcome = await refreshWorkspaceWitnessed(root, { cacheDir }).then((answer) => names(answer.index), (error: unknown) => error);
    vi.restoreAllMocks();
    expect(swapped).toBe(true);
    await swapDirectories(parent, elsewhere);
    expect(outcome).toMatchObject({ diagnostic: { code: "workspace-changing" } });
    const after = await refreshWorkspaceWitnessed(root, { cacheDir });
    expect(after.witness.root).toBe(root);
    expect(names(after.index)).toContain("onlyInP");
    expect(names(after.index)).not.toContain("onlyInQ");
  });

  // saveArtifact has published the locked root's index, then a parent is replaced. The writes that follow must still
  // name the locked root's cache entry, never the one the path now resolves to, and the refresh must not report success
  // for a root that no longer names the directory it scanned.
  it.each([
    ["a symlink", "symlink"],
    ["an ordinary directory", "exchange"],
  ] as const)("fails without writing another directory's cache when a parent is replaced by %s as the index is published", async (_, kind) => {
    const { parent, elsewhere, root, other, cacheDir } = await parentAndElsewhere();
    expect(names((await refreshWorkspaceWitnessed(root, { cacheDir })).index)).toContain("onlyInP");
    await fs.appendFile(path.join(root, "a.ts"), "export function addedInP() { return 3; }\n");
    const otherCache = workspaceDirFor(cacheDir, other);
    const published = path.join(workspaceDirFor(cacheDir, root), "index.sha");
    let replaced = false;
    aroundFirst("rename", (file) => file === published, async () => {}, async () => {
      if (kind === "symlink") await retargetToSymlink(parent, elsewhere);
      else await swapDirectories(parent, elsewhere);
      replaced = true;
    });
    const outcome = await refreshWorkspaceWitnessed(root, { cacheDir }).then((answer) => names(answer.index), (error: unknown) => error);
    vi.restoreAllMocks();
    expect(replaced).toBe(true);
    if (kind === "symlink") await restoreFromSymlink(parent);
    else await swapDirectories(parent, elsewhere);
    expect(outcome).toMatchObject({ diagnostic: { code: "workspace-changing" } });
    await expect(fs.access(otherCache)).rejects.toMatchObject({ code: "ENOENT" });
    const after = await refreshWorkspaceWitnessed(root, { cacheDir });
    expect(after.witness.root).toBe(root);
    expect(names(after.index)).toEqual(expect.arrayContaining(["onlyInP", "addedInP"]));
  });

  // The cache lies beneath the same parent as the root. The parent becomes a symlink to a directory with a cache of its
  // own just as the verification is published, after the check before that write, and is restored once it is written,
  // before the next check. Every write must still land in the cache directory whose lock the refresh holds. That takes a
  // descriptor bound to the cache directory; test/cache-bound-fallback.test.ts covers the platforms without one.
  it.runIf(process.platform === "linux")("writes only the locked cache directory when a parent of the cache is retargeted and restored during verification publication", async () => {
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
    const otherEntries = (await fs.readdir(otherCacheDir)).sort();
    await fs.appendFile(path.join(root, "a.ts"), "export function addedInP() { return 3; }\n");
    const key = path.basename(workspaceDirFor(cacheDir, root));
    let published = false;
    let retargeted = false;
    let restored = false;
    const mkdir = fs.mkdir.bind(fs) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(fs, "mkdir").mockImplementation((async (...args: unknown[]) => {
      if (published && !retargeted && path.basename(String(args[0])) === key) {
        await retargetToSymlink(parent, elsewhere);
        retargeted = true;
      }
      return await mkdir(...args);
    }) as never);
    const rename = fs.rename.bind(fs) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(fs, "rename").mockImplementation((async (...args: unknown[]) => {
      const settled = await rename(...args).then((value) => ({ value }), (error: unknown) => ({ error }));
      const name = path.basename(String(args[1]));
      if (name === "index.sha") published = true;
      if (retargeted && !restored && name === "verification.json") {
        await restoreFromSymlink(parent);
        restored = true;
      }
      if ("error" in settled) throw settled.error;
      return settled.value;
    }) as never);
    const outcome = await refreshWorkspaceWitnessed(root, { cacheDir }).then((answer) => answer, (error: unknown) => error);
    vi.restoreAllMocks();
    await restoreFromSymlink(parent);
    expect(retargeted && restored).toBe(true);
    expect((await fs.readdir(otherCacheDir)).sort()).toEqual(otherEntries);
    expect(outcome).toMatchObject({ witness: { root } });
    expect(names((outcome as Awaited<ReturnType<typeof refreshWorkspaceWitnessed>>).index)).toEqual(expect.arrayContaining(["onlyInP", "addedInP"]));
    await expect(fs.access(path.join(cacheDir, key, "verification.json"))).resolves.toBeUndefined();
  });

  // The checks between writes cannot see a retarget undone before the next check, so each write must name the locked
  // root's cache entry without resolving the path again. Here the parent is a symlink only while the refresh records
  // the workspace family, between the check before that write and the check before the refresh returns.
  it("writes only the locked root's cache when a parent is retargeted and restored between two checks", async () => {
    const { parent, elsewhere, root, other, cacheDir } = await parentAndElsewhere();
    expect(names((await refreshWorkspaceWitnessed(root, { cacheDir })).index)).toContain("onlyInP");
    await fs.utimes(path.join(root, "a.ts"), new Date(2_000_000_000_000), new Date(2_000_000_000_000));
    const own = workspaceDirFor(cacheDir, root);
    const otherCache = workspaceDirFor(cacheDir, other);
    await fs.rm(path.join(own, "family.json"));
    let retargeted = false;
    let restored = false;
    aroundFirst("readFile", (file) => file === path.join(own, "family.json"), async () => {
      await retargetToSymlink(parent, elsewhere);
      retargeted = true;
    });
    const original = cacheFs.rename.bind(cacheFs) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(cacheFs, "rename").mockImplementation((async (...args: unknown[]) => {
      const settled = await original(...args);
      if (retargeted && !restored && path.basename(String(args[1])) === "family.json") {
        restored = true;
        await restoreFromSymlink(parent);
      }
      return settled;
    }) as never);
    const outcome = await refreshWorkspaceWitnessed(root, { cacheDir }).then((answer) => answer, (error: unknown) => error);
    vi.restoreAllMocks();
    await restoreFromSymlink(parent);
    expect(retargeted && restored).toBe(true);
    expect(outcome).toMatchObject({ witness: { root } });
    expect(names((outcome as Awaited<ReturnType<typeof refreshWorkspaceWitnessed>>).index)).toContain("onlyInP");
    await expect(fs.access(path.join(own, "family.json"))).resolves.toBeUndefined();
    await expect(fs.access(otherCache)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
