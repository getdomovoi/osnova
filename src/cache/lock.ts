import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { promises as fs, readFileSync, renameSync, rmSync } from "node:fs";
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

interface HeldLocks {
  readonly leases: ReadonlyMap<string, { active: boolean }>;
  readonly options: LockOptions;
}

const held = new AsyncLocalStorage<HeldLocks>();

// A lock directory that names no live owner is reclaimed only once nothing inside it has changed for
// this long, so a process that is mid-way through creating or recovering it is never overtaken.
export const abandonedLockGraceMs = 5_000;

const ownedLocks = new Map<string, LockOwner>();
const stagedLocks = new Set<string>();

export class CacheLockTimeoutError extends IndexingError {
  constructor(lockPath: string, holder?: string | undefined) {
    super({ phase: "cache", path: lockPath, code: "cache-lock-timeout" });
    if (holder !== undefined) this.message = `${this.message}; ${holder}`;
  }
}

export function cacheLockTimeoutIn(error: unknown): CacheLockTimeoutError | undefined {
  let cause: unknown = error;
  for (let depth = 0; depth < 8 && cause !== null && cause !== undefined; depth += 1) {
    if (cause instanceof CacheLockTimeoutError) return cause;
    cause = (cause as { cause?: unknown }).cause;
  }
  return undefined;
}

export function holdsCacheLock(lockPath: string): boolean {
  return held.getStore()?.leases.get(path.resolve(lockPath))?.active === true;
}

const errorCode = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? "";

function parseOwner(text: string): LockOwner | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (typeof value !== "object" || value === null) return undefined;
  const owner = value as Partial<LockOwner>;
  if (!Number.isSafeInteger(owner.pid) || (owner.pid ?? 0) <= 0 || typeof owner.host !== "string" ||
    typeof owner.token !== "string" || !/^[0-9a-f-]{36}$/.test(owner.token)) return undefined;
  return owner as LockOwner;
}

export function lockOwnerExited(owner: LockOwner): boolean {
  if (owner.host !== os.hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return errorCode(error) === "ESRCH";
  }
}

const TRANSIENT_CODES = new Set(["ENOENT", "EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);

type OwnerState =
  | { readonly kind: "owner"; readonly owner: LockOwner }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "unsettled" };

// An owner file that cannot be read right now (another process is renaming or removing the lock,
// which Windows reports as EPERM or EBUSY) is not evidence of anything.
async function inspectOwner(lockPath: string): Promise<OwnerState> {
  let text: string;
  try {
    text = await fs.readFile(path.join(lockPath, "owner.json"), "utf8");
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return { kind: "missing" };
    if (TRANSIENT_CODES.has(code)) return { kind: "unsettled" };
    throw error;
  }
  const owner = parseOwner(text);
  return owner === undefined ? { kind: "invalid" } : { kind: "owner", owner };
}

interface LockSnapshot {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeMs: number;
  readonly names: readonly string[];
  readonly owner: OwnerState;
}

async function snapshot(lockPath: string): Promise<LockSnapshot | undefined> {
  try {
    const stat = await fs.lstat(lockPath, { bigint: true });
    if (!stat.isDirectory()) return undefined;
    const names = (await fs.readdir(lockPath)).sort();
    return { dev: stat.dev, ino: stat.ino, mtimeMs: Number(stat.mtimeMs), names, owner: await inspectOwner(lockPath) };
  } catch (error) {
    if (TRANSIENT_CODES.has(errorCode(error))) return undefined;
    throw error;
  }
}

const isRecoveryMarker = (name: string): boolean => name === "recovery" || /^recovery-\d+$/.test(name);

// A lock is abandoned when it names an owner that has exited, or when it names no usable owner at
// all. The second state is what a process killed between creating the directory and writing its
// owner (or between removing the owner and the directory) leaves behind under the previous
// protocol, and what a recoverer killed mid-recovery leaves behind under either protocol. Only the
// exact exited-owner state is taken at once; every other state must also have been quiet for the
// grace period. Unknown entries are never reclaimed: they are not ours to delete.
function isAbandoned(lock: LockSnapshot): boolean {
  if (lock.owner.kind === "unsettled") return false;
  if (lock.names.some((name) => name !== "owner.json" && !isRecoveryMarker(name))) return false;
  if (lock.owner.kind === "owner") {
    if (!lockOwnerExited(lock.owner.owner)) return false;
    if (!lock.names.some(isRecoveryMarker)) return true;
  }
  return Math.abs(Date.now() - lock.mtimeMs) >= abandonedLockGraceMs;
}

function sameLock(before: LockSnapshot, after: LockSnapshot, marker: string): boolean {
  if (after.dev !== before.dev || after.ino !== before.ino) return false;
  const expected = [...before.names, marker].sort();
  if (after.names.length !== expected.length || after.names.some((name, i) => name !== expected[i])) return false;
  if (after.owner.kind !== before.owner.kind) return false;
  return after.owner.kind !== "owner" || before.owner.kind !== "owner" || after.owner.owner.token === before.owner.owner.token;
}

async function removeMarker(marker: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rmdir(marker);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") return;
      if (!TRANSIENT_CODES.has(code) || attempt >= 40) throw error;
      await delay(25);
    }
  }
}

// Recoverers exclude each other with a marker directory whose name counts the markers already
// present, so every process that observed the same abandoned state competes for the same name and
// a process that observed an older state cannot win. The first marker keeps the name `recovery`,
// which older osnova processes also compete for.
async function recoverAbandonedLock(lockPath: string): Promise<void> {
  const observed = await snapshot(lockPath);
  if (observed === undefined || !isAbandoned(observed)) return;
  const markers = observed.names.filter(isRecoveryMarker).length;
  const markerName = markers === 0 ? "recovery" : `recovery-${markers}`;
  const marker = path.join(lockPath, markerName);
  try {
    await fs.mkdir(marker);
  } catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST" || TRANSIENT_CODES.has(code)) return;
    throw error;
  }
  const abandoned = `${lockPath}.abandoned-${randomUUID()}`;
  let moved = false;
  try {
    const current = await snapshot(lockPath);
    if (current === undefined || !sameLock(observed, current, markerName)) return;
    await fs.rename(lockPath, abandoned);
    moved = true;
  } catch (error) {
    if (!TRANSIENT_CODES.has(errorCode(error))) throw error;
    return;
  } finally {
    if (!moved) await removeMarker(marker);
  }
  await fs.rm(abandoned, { recursive: true, force: true }).catch(() => {});
}

async function describeHolder(lockPath: string): Promise<string> {
  const remedy = `if no osnova process is using this cache, delete ${lockPath}`;
  const lock = await snapshot(lockPath).catch(() => undefined);
  if (lock === undefined) return remedy;
  if (lock.names.some((name) => name !== "owner.json" && !isRecoveryMarker(name))) {
    return `the lock directory holds unexpected entries (${lock.names.join(", ")}); ${remedy}`;
  }
  if (lock.owner.kind === "owner") return `held by pid ${lock.owner.owner.pid} on ${lock.owner.owner.host}; ${remedy}`;
  return `the lock directory names no owner; ${remedy}`;
}

async function releaseOwnedLock(lockPath: string, owner: LockOwner): Promise<void> {
  ownedLocks.delete(lockPath);
  const ownershipLost = (): IndexingError => new IndexingError({ phase: "cache", path: lockPath, code: "cache-lock-ownership-lost" });
  const deadline = performance.now() + 1000;
  let current = await inspectOwner(lockPath);
  while (current.kind === "unsettled" && performance.now() < deadline) {
    await delay(5);
    current = await inspectOwner(lockPath);
  }
  if (current.kind !== "owner" || current.owner.token !== owner.token) throw ownershipLost();
  // Moving the whole directory aside is the release. Removing owner.json first would leave, for as
  // long as it takes to remove the directory, a lock that names no owner.
  const released = `${lockPath}.released-${owner.token}`;
  for (;;) {
    try {
      await fs.rename(lockPath, released);
      break;
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") throw ownershipLost();
      if (!TRANSIENT_CODES.has(code) || performance.now() >= deadline) throw error;
      await delay(5);
    }
  }
  await fs.rm(released, { recursive: true, force: true }).catch(() => {});
}

// For a process that is about to exit on a signal: release every lock it holds and remove every
// lock it was still waiting for, synchronously, so no cache operation can interleave.
export function releaseHeldCacheLocksSync(): void {
  for (const staged of stagedLocks) {
    try { rmSync(staged, { recursive: true, force: true }); } catch { /* exiting: best effort */ }
  }
  stagedLocks.clear();
  for (const [lockPath, owner] of ownedLocks) {
    try {
      if (parseOwner(readFileSync(path.join(lockPath, "owner.json"), "utf8"))?.token !== owner.token) continue;
      const released = `${lockPath}.released-${owner.token}`;
      renameSync(lockPath, released);
      rmSync(released, { recursive: true, force: true });
    } catch { /* exiting: an unreleased lock names this dead process and is recovered */ }
  }
  ownedLocks.clear();
}

const DEBRIS_RE = /\.(?:acquire|released|abandoned)-[0-9a-f-]{36}$/;

async function quietFor(target: string, ms: number): Promise<boolean> {
  try {
    return Math.abs(Date.now() - (await fs.lstat(target)).mtimeMs) >= ms;
  } catch {
    return false;
  }
}

// A process killed while a lock directory sits under a private staged, released or abandoned name
// leaves that directory behind. It blocks nothing, and it is removed here once the process named
// in it has exited.
export async function sweepLockDebris(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  for (const name of names.filter((entry) => DEBRIS_RE.test(entry))) {
    const debris = path.join(dir, name);
    const state = await inspectOwner(debris).catch((): OwnerState => ({ kind: "unsettled" }));
    if (state.kind === "unsettled") continue;
    const gone = state.kind === "owner" ? lockOwnerExited(state.owner) : await quietFor(debris, abandonedLockGraceMs);
    if (gone) await fs.rm(debris, { recursive: true, force: true }).catch(() => {});
  }
}

async function isSymlink(target: string): Promise<boolean> {
  try {
    return (await fs.lstat(target)).isSymbolicLink();
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

export async function withCacheLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  lockPath = path.resolve(lockPath);
  if (holdsCacheLock(lockPath)) return operation();
  const store = held.getStore();
  const inherited = store?.options ?? {};
  const timeout = options.lockTimeoutMs ?? inherited.lockTimeoutMs ?? 10_000;
  const poll = options.lockPollMs ?? inherited.lockPollMs ?? 25;
  if (!Number.isFinite(timeout) || timeout < 0 || !Number.isFinite(poll) || poll <= 0) {
    throw new RangeError("osnova: lock timeout must be nonnegative and poll interval positive");
  }
  const owner: LockOwner = { pid: process.pid, host: os.hostname(), token: randomUUID() };
  const deadline = performance.now() + timeout;
  // The lock directory is built complete under a private name and renamed into place, so the lock
  // path never exists without its owner.
  const staged = `${lockPath}.acquire-${owner.token}`;
  stagedLocks.add(staged);
  try {
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.mkdir(staged);
    await fs.writeFile(path.join(staged, "owner.json"), JSON.stringify(owner), { flag: "wx" });
    for (;;) {
      try {
        await fs.rename(staged, lockPath);
        ownedLocks.set(lockPath, owner);
        break;
      } catch (error) {
        if (await isSymlink(lockPath)) throw new Error("cache lock must not be a symlink");
        // EEXIST and ENOTEMPTY are the normal contended case. A transient code means another
        // process is mid-way through renaming or removing the lock directory (Windows answers EPERM
        // or EBUSY for the moment it takes); poll again rather than fail the whole cache operation.
        const code = errorCode(error);
        if (code !== "EEXIST" && !TRANSIENT_CODES.has(code)) throw error;
        await recoverAbandonedLock(lockPath);
        if (performance.now() >= deadline) throw new CacheLockTimeoutError(lockPath, await describeHolder(lockPath));
        await delay(Math.min(poll, Math.max(1, deadline - performance.now())));
      }
    }
  } catch (error) {
    await fs.rm(staged, { recursive: true, force: true }).catch(() => {});
    if (error instanceof IndexingError) throw error;
    throw new IndexingError({ phase: "cache", path: lockPath, code: "cache-lock-failed" }, error);
  } finally {
    stagedLocks.delete(staged);
  }
  const lease = { active: true };
  const leases = new Map([...(store?.leases ?? []), [lockPath, lease]]);
  let result: T;
  try {
    result = await held.run({ leases, options: { lockTimeoutMs: timeout, lockPollMs: poll } }, operation);
  } catch (error) {
    lease.active = false;
    // The operation's own failure is the one the caller can act on; a failed release must not
    // replace it.
    await releaseOwnedLock(lockPath, owner).catch(() => {});
    throw error;
  }
  lease.active = false;
  await releaseOwnedLock(lockPath, owner);
  return result;
}
