import { afterEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import * as lock from "../src/cache/lock.js";

const { withCacheLock } = lock;

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return pid;
}

const temporary: string[] = [];

async function freshLockPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-lock-wedge-"));
  temporary.push(dir);
  return path.join(dir, "workspace.lock");
}

async function wedgedLock(fill: (lockPath: string) => Promise<void>, ageMs = 60_000): Promise<string> {
  const lockPath = await freshLockPath();
  await fs.mkdir(lockPath);
  await fill(lockPath);
  const then = new Date(Date.now() - ageMs);
  for (const name of await fs.readdir(lockPath)) await fs.utimes(path.join(lockPath, name), then, then);
  await fs.utimes(lockPath, then, then);
  return lockPath;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

it.each([
  ["an empty lock directory, left by a kill between releasing the owner and removing the directory", async () => {}],
  ["a lock directory holding only a recovery marker", async (lockPath: string) => { await fs.mkdir(path.join(lockPath, "recovery")); }],
  ["an exited owner beside the marker of a recoverer that was killed", async (lockPath: string) => {
    await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ pid: await exitedPid(), host: os.hostname(), token: randomUUID() }));
    await fs.mkdir(path.join(lockPath, "recovery"));
  }],
  ["a torn owner file", async (lockPath: string) => { await fs.writeFile(path.join(lockPath, "owner.json"), "{\"pid\":12"); }],
])("reclaims %s", async (_state, fill) => {
  const lockPath = await wedgedLock(fill);
  await expect(withCacheLock(lockPath, async () => "entered", { lockTimeoutMs: 3_000, lockPollMs: 5 })).resolves.toBe("entered");
  expect(await fs.readdir(path.dirname(lockPath))).toEqual([]);
});

it("does not reclaim an ownerless lock that changed within the grace period, and does once it has been quiet", async () => {
  const lockPath = await wedgedLock(async (target) => { await fs.mkdir(path.join(target, "recovery")); }, 0);
  await expect(withCacheLock(lockPath, async () => "entered", { lockTimeoutMs: 100, lockPollMs: 5 })).rejects.toThrow(/cache-lock-timeout/);
  expect(await fs.readdir(lockPath)).toEqual(["recovery"]);
  const then = new Date(Date.now() - 60_000);
  await fs.utimes(path.join(lockPath, "recovery"), then, then);
  await fs.utimes(lockPath, then, then);
  await expect(withCacheLock(lockPath, async () => "entered", { lockTimeoutMs: 3_000, lockPollMs: 5 })).resolves.toBe("entered");
});

it("treats an ownerless lock whose mtime is in the future as held, not as abandoned", async () => {
  const lockPath = await wedgedLock(async (target) => { await fs.mkdir(path.join(target, "recovery")); }, -60_000);
  await expect(withCacheLock(lockPath, async () => "entered", { lockTimeoutMs: 100, lockPollMs: 5 })).rejects.toThrow(/cache-lock-timeout/);
  expect(await fs.readdir(lockPath)).toEqual(["recovery"]);
});

it("never moves a lock that another process took between the reclaim decision and the reclaim", async () => {
  const lockPath = await wedgedLock(async (target) => {
    await fs.writeFile(path.join(target, "owner.json"), JSON.stringify({ pid: await exitedPid(), host: os.hostname(), token: randomUUID() }));
  });
  const rename = fs.rename.bind(fs);
  let active = 0;
  let overlapped = false;
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => { openGate = resolve; });
  let second: Promise<unknown> | undefined;
  let paused = false;
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    const destructive = String(from).startsWith(lockPath) && /\.(abandoned|reclaim)-/.test(String(to));
    if (!destructive || paused) return rename(from, to);
    paused = true;
    // The reclaimer has decided and is about to act. Let the decision go stale: time passes beyond
    // the grace period and a second process reclaims the lock and takes it.
    const then = new Date(Date.now() - 60_000);
    for (const name of await fs.readdir(lockPath)) await fs.utimes(path.join(lockPath, name), then, then);
    await fs.utimes(lockPath, then, then);
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    second = withCacheLock(lockPath, async () => { active += 1; entered(); await gate; active -= 1; }, { lockTimeoutMs: 5_000, lockPollMs: 5 })
      .then(() => "released", (error: unknown) => (error as Error).message);
    await inside;
    const result = await rename(from, to).then(() => undefined, (error: unknown) => error);
    setTimeout(openGate, 100);
    if (result !== undefined) throw result;
  });
  const first = await withCacheLock(lockPath, async () => { if (active > 0) overlapped = true; return "entered"; }, { lockTimeoutMs: 5_000, lockPollMs: 5 });
  openGate();
  expect(first).toBe("entered");
  expect(paused).toBe(true);
  expect(overlapped).toBe(false);
  expect(await second).toBe("released");
});

it("never leaves the lock path in place without its owner file while acquiring or releasing", async () => {
  const lockPath = await freshLockPath();
  const violations: string[] = [];
  const check = async (step: string): Promise<void> => {
    const names = await fs.readdir(lockPath).catch(() => undefined);
    if (names !== undefined && !names.includes("owner.json")) violations.push(`${step}: [${names.join(",")}]`);
  };
  for (const name of ["mkdir", "writeFile", "unlink", "rmdir", "rename", "rm"] as const) {
    const real = (fs[name] as (...args: unknown[]) => Promise<unknown>).bind(fs);
    vi.spyOn(fs, name).mockImplementation((async (...args: unknown[]) => {
      const result = await real(...args);
      await check(`${name} ${path.basename(String(args[0]))}`);
      return result;
    }) as never);
  }
  await withCacheLock(lockPath, async () => {});
  expect(violations).toEqual([]);
  await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("names the lock path, its holder and the remedy when it times out", async () => {
  const lockPath = await freshLockPath();
  await fs.mkdir(lockPath);
  await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, host: os.hostname(), token: randomUUID() }));
  const error = await withCacheLock(lockPath, async () => {}, { lockTimeoutMs: 50, lockPollMs: 5 }).catch((caught: unknown) => caught as Error);
  expect(error).toMatchObject({ diagnostic: { code: "cache-lock-timeout", path: lockPath } });
  expect((error as Error).message).toContain(`held by pid ${process.pid}`);
  expect((error as Error).message).toContain(`delete ${lockPath}`);
});

it("reports the operation's failure even when the lock was taken away underneath it", async () => {
  const lockPath = await freshLockPath();
  const error = await withCacheLock(lockPath, async () => {
    await fs.rename(lockPath, `${lockPath}.stolen`);
    throw new Error("REAL-INDEXING-FAILURE");
  }).catch((caught: unknown) => caught as Error);
  expect((error as Error).message).toBe("REAL-INDEXING-FAILURE");
});

it("applies the caller's lock timeout to the locks taken inside its operation", async () => {
  const outer = await freshLockPath();
  const inner = path.join(path.dirname(outer), ".eviction.lock");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const holding = withCacheLock(inner, () => gate);
  while (!(await fs.stat(inner).then(() => true, () => false))) await new Promise((resolve) => setTimeout(resolve, 5));
  const started = performance.now();
  const error = await withCacheLock(outer, () => withCacheLock(inner, async () => "entered"), { lockTimeoutMs: 150, lockPollMs: 5 })
    .catch((caught: unknown) => caught as Error);
  const elapsed = performance.now() - started;
  release();
  await holding;
  expect(error).toMatchObject({ diagnostic: { code: "cache-lock-timeout", path: inner } });
  expect(elapsed).toBeLessThan(2_000);
});

it("releases every held lock and removes every pending acquisition synchronously for a signal", async () => {
  expect(lock.releaseHeldCacheLocksSync).toBeTypeOf("function");
  const held = await freshLockPath();
  const waited = path.join(path.dirname(held), "other.lock");
  await fs.mkdir(waited);
  await fs.writeFile(path.join(waited, "owner.json"), JSON.stringify({ pid: process.pid, host: os.hostname(), token: randomUUID() }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const holding = withCacheLock(held, () => gate);
  const waiting = withCacheLock(waited, async () => {}, { lockTimeoutMs: 400, lockPollMs: 5 }).catch((caught: unknown) => caught);
  const pending = async (): Promise<boolean> => (await fs.readdir(path.dirname(held))).some((name) => name.startsWith("other.lock.acquire-"));
  while (!(await fs.stat(held).then(() => true, () => false)) || !(await pending())) await new Promise((resolve) => setTimeout(resolve, 5));
  lock.releaseHeldCacheLocksSync();
  expect((await fs.readdir(path.dirname(held))).sort()).toEqual(["other.lock"]);
  release();
  await expect(holding).rejects.toThrow(/cache-lock-ownership-lost/);
  await waiting;
});
