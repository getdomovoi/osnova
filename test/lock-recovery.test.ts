import { afterEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { foreignLockHolds, withCacheLock } from "../src/cache/lock.js";

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return pid;
}

async function deadLock(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-lock-recovery-"));
  const lockPath = path.join(dir, "cache", "workspace.lock");
  await fs.mkdir(lockPath, { recursive: true });
  await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ pid: await exitedPid(), host: os.hostname(), token: randomUUID() }));
  return lockPath;
}

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

afterEach(() => vi.restoreAllMocks());

it("recovers a dead owner even when the first rename and the first directory removal of the reclaim fail transiently", async () => {
  const lockPath = await deadLock();
  const rename = fs.rename.bind(fs);
  const rmdir = fs.rmdir.bind(fs);
  let renameFailures = 1;
  let rmdirFailures = 1;
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (renameFailures > 0 && String(from) === path.join(lockPath, "owner.json")) { renameFailures -= 1; throw errno("EPERM"); }
    return rename(from, to);
  });
  vi.spyOn(fs, "rmdir").mockImplementation(async (target, options) => {
    if (rmdirFailures > 0 && String(target) === lockPath) { rmdirFailures -= 1; throw errno("EBUSY"); }
    return rmdir(target, options);
  });
  let entered = 0;
  await Promise.all([1, 2].map(() => withCacheLock(lockPath, async () => { entered += 1; }, { lockTimeoutMs: 5_000, lockPollMs: 5 })));
  expect(entered).toBe(2);
  expect(renameFailures).toBe(0);
  expect(rmdirFailures).toBe(0);
  await expect(fs.readdir(path.dirname(lockPath))).resolves.toEqual([]);
});

it("does not recover a lock whose owner is alive", async () => {
  const lockPath = await deadLock();
  await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, host: os.hostname(), token: randomUUID() }));
  await expect(withCacheLock(lockPath, async () => "entered", { lockTimeoutMs: 50, lockPollMs: 5 })).rejects.toThrow(/cache-lock-timeout/);
  expect(await fs.readdir(lockPath)).toEqual(["owner.json"]);
});

it("keeps polling when the lock directory cannot be created or its owner read for a moment, as Windows reports mid-rename", async () => {
  const lockPath = await deadLock();
  const rename = fs.rename.bind(fs);
  const readFile = fs.readFile.bind(fs);
  let mkdirFailures = 0, readFailures = 0;
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (String(to) === lockPath && mkdirFailures < 1) { mkdirFailures += 1; throw errno("EPERM"); }
    return rename(from, to);
  });
  vi.spyOn(fs, "readFile").mockImplementation(async (target, options) => {
    if (String(target) === path.join(lockPath, "owner.json") && readFailures < 1) { readFailures += 1; throw errno("EBUSY"); }
    return readFile(target as never, options as never) as Promise<never>;
  });
  const ran = await withCacheLock(lockPath, async () => "ran", { lockTimeoutMs: 5_000, lockPollMs: 5 });
  expect(ran).toBe("ran");
  expect(mkdirFailures).toBe(1);
  expect(readFailures).toBe(1);
  await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("clears a lock directory it emptied itself, without waiting out the grace period", async () => {
  const lockPath = await deadLock();
  const rmdir = fs.rmdir.bind(fs);
  const rename = fs.rename.bind(fs);
  let rmdirFailures = 1;
  vi.spyOn(fs, "rmdir").mockImplementation(async (target, options) => {
    if (rmdirFailures > 0 && String(target) === lockPath) { rmdirFailures -= 1; throw errno("EBUSY"); }
    return rmdir(target, options);
  });
  // Windows refuses to rename a directory onto an existing one even when that one is empty, so an
  // empty lock directory cannot simply be taken over there the way it can on Linux and macOS.
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (String(to) === lockPath) {
      let exists = true;
      try { await fs.stat(lockPath); } catch { exists = false; }
      if (exists) throw errno("EPERM");
    }
    return rename(from, to);
  });
  const started = performance.now();
  await withCacheLock(lockPath, async () => {}, { lockTimeoutMs: 30_000, lockPollMs: 5 });
  // What the reclaimer emptied a moment ago names nobody and cannot be held by anyone. Waiting
  // abandonedLockGraceMs for it is the bug.
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(rmdirFailures).toBe(0);
});

// Runs the probe on an exited owner's lock and, once its nth read of the lock directory or a file in it has
// returned, lets a publisher reclaim that lock and take it before the probe goes on. Whatever the probe
// read up to then describes only the exited owner.
async function probeRacingPublisherAt(nth: number): Promise<{ held: boolean; raced: boolean }> {
  const lockPath = await deadLock();
  const lstat = fs.lstat.bind(fs);
  const readFile = fs.readFile.bind(fs);
  let release!: () => void;
  const releasing = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  let publisher: Promise<void> | undefined;
  const afterRead = async (target: unknown): Promise<void> => {
    const name = String(target);
    if (publisher !== undefined || (name !== lockPath && path.dirname(name) !== lockPath) || ++reads !== nth) return;
    let acquired!: () => void;
    const holding = new Promise<void>((resolve) => { acquired = resolve; });
    publisher = withCacheLock(lockPath, async () => { acquired(); await releasing; }, { lockTimeoutMs: 5_000, lockPollMs: 5 });
    await holding;
  };
  vi.spyOn(fs, "lstat").mockImplementation(async (target, options) => {
    const stat = await lstat(target, options as never) as never;
    await afterRead(target);
    return stat;
  });
  vi.spyOn(fs, "readFile").mockImplementation(async (target, options) => {
    const text = await readFile(target as never, options as never) as never;
    await afterRead(target);
    return text;
  });
  try {
    return { held: await foreignLockHolds(lockPath), raced: publisher !== undefined };
  } finally {
    vi.restoreAllMocks();
    release();
    await publisher;
  }
}

it("reports a lock as held when a publisher reclaims the exited owner while the probe reads it", async () => {
  const { held, raced } = await probeRacingPublisherAt(1);
  expect(held).toBe(true);
  expect(raced).toBe(true);
});

it("reports a lock as held when a publisher takes it after any read of the exited owner's lock", async () => {
  for (let nth = 1; ; nth += 1) {
    const { held, raced } = await probeRacingPublisherAt(nth);
    if (!raced) {
      expect(nth).toBeGreaterThan(1);
      break;
    }
    expect({ nth, held }).toEqual({ nth, held: true });
  }
});

it("reports any existing lock directory this process does not hold as held, and a missing one as free", async () => {
  const lockPath = await deadLock();
  await expect(foreignLockHolds(lockPath)).resolves.toBe(true);
  await fs.rm(lockPath, { recursive: true, force: true });
  await expect(foreignLockHolds(lockPath)).resolves.toBe(false);
  await withCacheLock(lockPath, async () => {
    await expect(foreignLockHolds(lockPath)).resolves.toBe(false);
  });
});
