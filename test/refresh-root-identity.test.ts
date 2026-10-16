import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs, realpathSync, renameSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { refreshWorkspaceWitnessed } from "../src/api.js";
import { workspaceDirFor, workspaceLockPath } from "../src/cache/cache.js";
import { scanSerial } from "../src/index/scan.js";

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

// Resolves when fs.rename is first called with the given path as its destination.
function renamedOnto(target: string): Promise<void> {
  const original = fs.rename.bind(fs) as (...args: unknown[]) => Promise<unknown>;
  return new Promise((resolve) => {
    vi.spyOn(fs, "rename").mockImplementation((async (...args: unknown[]) => {
      if (path.resolve(String(args[1])) === target) resolve();
      return await original(...args);
    }) as never);
  });
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

  // The scan resolved the locked root, then a parent directory became a symlink, so loading the cached index or
  // building one resolves the same path to another directory. Restoring the parent afterwards must not leave a
  // witness of the locked root's scan paired with the other directory's index.
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
    const before = scanSerial();
    const original = realpathSync.native;
    let retargeted = false;
    vi.spyOn(realpathSync, "native").mockImplementation(((...args: Parameters<typeof original>) => {
      if (!retargeted && scanSerial() > before && path.resolve(String(args[0])) === root) {
        retargeted = true;
        renameSync(parent, `${parent}-saved`);
        symlinkSync(elsewhere, parent, "dir");
      }
      return original(...args);
    }) as typeof original);
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

  // Inspection resolved the locked root, then a parent became a symlink to a directory with the same sources, so the
  // hashes match and nothing is stale. Writing the verification now would resolve the path to the other directory.
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
    duringRealpath(root, () => new Error().stack?.includes("inspectFreshness") === true, async () => {}, async () => {
      await fs.rename(parent, `${parent}-saved`);
      await fs.symlink(elsewhere, parent, "dir");
    });
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
});
