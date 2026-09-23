import { afterEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { withCacheLock } from "../src/cache/lock.js";

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

it("recovers a dead owner even when the first rename and the first marker removal fail transiently", async () => {
  const lockPath = await deadLock();
  const rename = fs.rename.bind(fs);
  const rmdir = fs.rmdir.bind(fs);
  let renameFailures = 1;
  let rmdirFailures = 1;
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (renameFailures > 0 && String(from) === lockPath) { renameFailures -= 1; throw errno("EPERM"); }
    return rename(from, to);
  });
  vi.spyOn(fs, "rmdir").mockImplementation(async (target, options) => {
    if (rmdirFailures > 0 && String(target) === path.join(lockPath, "recovery")) { rmdirFailures -= 1; throw errno("EBUSY"); }
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
