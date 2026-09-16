import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { IndexingError } from "../index/diagnostics.js";

export interface LockOptions {
  readonly lockTimeoutMs?: number | undefined;
  readonly lockPollMs?: number | undefined;
}

export interface LockOwner {
  readonly pid: number;
  readonly host: string;
  readonly token: string;
}

const held = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>();

export class CacheLockTimeoutError extends IndexingError {
  constructor(lockPath: string) {
    super({ phase: "cache", path: lockPath, code: "cache-lock-timeout" });
  }
}

export function holdsCacheLock(lockPath: string): boolean {
  return held.getStore()?.get(path.resolve(lockPath))?.active === true;
}

async function readOwner(lockPath: string): Promise<LockOwner | undefined> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8"));
    if (typeof value !== "object" || value === null) return undefined;
    const owner = value as Partial<LockOwner>;
    if (!Number.isSafeInteger(owner.pid) || (owner.pid ?? 0) <= 0 || typeof owner.host !== "string" ||
      typeof owner.token !== "string" || !/^[0-9a-f-]{36}$/.test(owner.token)) return undefined;
    return owner as LockOwner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export function lockOwnerExited(owner: LockOwner): boolean {
  if (owner.host !== os.hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function recoverExitedOwner(lockPath: string): Promise<void> {
  const owner = await readOwner(lockPath);
  if (owner === undefined || !lockOwnerExited(owner)) return;
  const names = await fs.readdir(lockPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  if (names.length !== 1 || names[0] !== "owner.json") return;
  const recovery = path.join(lockPath, "recovery");
  try {
    await fs.mkdir(recovery);
  } catch (error) {
    if (["EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
  const current = await readOwner(lockPath);
  if (current?.token !== owner.token || !lockOwnerExited(current) ||
    (await fs.readdir(lockPath)).some((name) => name !== "owner.json" && name !== "recovery")) {
    await fs.rmdir(recovery);
    return;
  }
  const abandoned = `${lockPath}.abandoned-${randomUUID()}`;
  await fs.rename(lockPath, abandoned);
  await fs.unlink(path.join(abandoned, "owner.json"));
  await fs.rmdir(path.join(abandoned, "recovery"));
  await fs.rmdir(abandoned);
}

async function releaseOwnedLock(lockPath: string, owner: LockOwner): Promise<void> {
  if ((await readOwner(lockPath))?.token !== owner.token) {
    throw new IndexingError({ phase: "cache", path: lockPath, code: "cache-lock-ownership-lost" });
  }
  await fs.unlink(path.join(lockPath, "owner.json"));
  const deadline = performance.now() + 1000;
  for (;;) {
    try {
      await fs.rmdir(lockPath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" || performance.now() >= deadline) throw error;
      await delay(5);
    }
  }
}

export async function withCacheLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  lockPath = path.resolve(lockPath);
  if (holdsCacheLock(lockPath)) return operation();
  const timeout = options.lockTimeoutMs ?? 10_000;
  const poll = options.lockPollMs ?? 25;
  if (!Number.isFinite(timeout) || timeout < 0 || !Number.isFinite(poll) || poll <= 0) {
    throw new RangeError("osnova: lock timeout must be nonnegative and poll interval positive");
  }
  const owner: LockOwner = { pid: process.pid, host: os.hostname(), token: randomUUID() };
  const deadline = performance.now() + timeout;
  try {
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    for (;;) {
      try {
        await fs.mkdir(lockPath);
        try {
          await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify(owner), { flag: "wx" });
        } catch (error) {
          await fs.rmdir(lockPath).catch(() => {});
          throw error;
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if ((await fs.lstat(lockPath).catch((statError: unknown) => {
          if ((statError as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw statError;
        }))?.isSymbolicLink()) throw new Error("cache lock must not be a symlink");
        await recoverExitedOwner(lockPath);
        if (performance.now() >= deadline) throw new CacheLockTimeoutError(lockPath);
        await delay(Math.min(poll, Math.max(1, deadline - performance.now())));
      }
    }
  } catch (error) {
    if (error instanceof IndexingError) throw error;
    throw new IndexingError({ phase: "cache", path: lockPath, code: "cache-lock-failed" }, error);
  }
  const lease = { active: true };
  try {
    return await held.run(new Map([...(held.getStore() ?? []), [lockPath, lease]]), operation);
  } finally {
    lease.active = false;
    await releaseOwnedLock(lockPath, owner);
  }
}
