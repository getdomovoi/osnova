import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { promises as fs, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
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
// this long, so a process that is mid-way through creating or reclaiming it is never overtaken.
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

const OWNER_FILE = "owner.json";
const SET_ASIDE_RE = /^owner\.json\.reclaim-[0-9a-f-]{36}$/;
const LEGACY_MARKER = "recovery";
const isOwnerFile = (name: string): boolean => name === OWNER_FILE || SET_ASIDE_RE.test(name);
const isKnownEntry = (name: string): boolean => isOwnerFile(name) || name === LEGACY_MARKER;

// Quiet time is measured against the wall clock. A modification time in the future cannot be told
// apart from a lock taken a moment ago after the clock stepped back, so it never counts as quiet:
// a skewed clock may delay recovery, but it must never hand a live lock to a second process.
function quietSince(mtimeMs: number): boolean {
  return Date.now() - mtimeMs >= abandonedLockGraceMs;
}

async function ignoreMissing(step: Promise<unknown>): Promise<void> {
  try {
    await step;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

interface OwnerEntry {
  readonly name: string;
  readonly text: string;
  readonly owner: LockOwner | undefined;
}

interface LockSnapshot {
  readonly mtimeMs: number;
  readonly names: readonly string[];
  readonly owners: readonly OwnerEntry[];
  // False when an owner file could not be read right now (another process is renaming or removing
  // it, which Windows reports as EPERM or EBUSY). Such a snapshot is not evidence of anything.
  readonly settled: boolean;
}

async function snapshot(dir: string): Promise<LockSnapshot | undefined> {
  try {
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory()) return undefined;
    const names = (await fs.readdir(dir)).sort();
    const owners: OwnerEntry[] = [];
    let settled = true;
    for (const name of names.filter(isOwnerFile)) {
      try {
        const text = await fs.readFile(path.join(dir, name), "utf8");
        owners.push({ name, text, owner: parseOwner(text) });
      } catch (error) {
        if (!TRANSIENT_CODES.has(errorCode(error))) throw error;
        settled = false;
      }
    }
    return { mtimeMs: stat.mtimeMs, names, owners, settled };
  } catch (error) {
    if (TRANSIENT_CODES.has(errorCode(error))) return undefined;
    throw error;
  }
}

// A lock is abandoned when every owner it names has exited, or when it names no usable owner at
// all: the residue of a process killed while creating or removing a lock under the previous
// protocol, or of a reclaimer killed part-way. Only the plain exited-owner state is taken at once;
// every other state must also have been quiet for the grace period. Unknown entries are never
// reclaimed: they are not ours to delete.
function isAbandoned(lock: LockSnapshot): boolean {
  if (!lock.settled || lock.names.some((name) => !isKnownEntry(name))) return false;
  if (lock.owners.some((entry) => entry.owner !== undefined && !lockOwnerExited(entry.owner))) return false;
  const [only] = lock.owners;
  if (lock.names.length === 1 && only?.name === OWNER_FILE && only.owner !== undefined) return true;
  return quietSince(lock.mtimeMs);
}

// owner.json is the one name every owner shares, so it is first moved to a name only this process
// uses and compared with what was observed. Another owner's file is moved straight back; while it
// is set aside it stays inside the lock directory, so the directory is not empty and that owner
// still holds the lock, and its release recognises the set-aside file as its own.
async function removeObservedOwner(lockPath: string, entry: OwnerEntry): Promise<boolean> {
  const file = path.join(lockPath, entry.name);
  if (entry.name !== OWNER_FILE) {
    await ignoreMissing(fs.unlink(file));
    return true;
  }
  const aside = path.join(lockPath, `${OWNER_FILE}.reclaim-${randomUUID()}`);
  try {
    await fs.rename(file, aside);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    throw error;
  }
  let text: string | undefined;
  try {
    text = await fs.readFile(aside, "utf8");
  } finally {
    if (text !== entry.text) await ignoreMissing(fs.rename(aside, file));
  }
  if (text !== entry.text) return false;
  await ignoreMissing(fs.unlink(aside));
  return true;
}

// Reclaiming never renames or removes the lock directory as a whole: a rename cannot check what it
// moves, so a reclaimer acting on a stale observation could move a lock another process had just
// taken. It removes only the entries it observed, each by a step that cannot remove anything a
// newer owner put there, and then removes the directory only if it is empty. A held lock always
// contains its owner file, so a stale reclaim fails at that last step and the holder keeps the lock.
// Concurrent reclaimers need no marker: every step is idempotent.
async function reclaimAbandonedLock(lockPath: string): Promise<void> {
  const observed = await snapshot(lockPath);
  if (observed === undefined || !isAbandoned(observed)) return;
  try {
    for (const entry of observed.owners) {
      if (!(await removeObservedOwner(lockPath, entry))) return;
    }
    if (observed.names.includes(LEGACY_MARKER)) await ignoreMissing(fs.rmdir(path.join(lockPath, LEGACY_MARKER)));
    await fs.rmdir(lockPath);
  } catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST" || TRANSIENT_CODES.has(code)) return;
    throw error;
  }
}

async function describeHolder(lockPath: string): Promise<string> {
  const remedy = `if no osnova process is using this cache, delete ${lockPath}`;
  const lock = await snapshot(lockPath).catch(() => undefined);
  if (lock === undefined) return remedy;
  const unexpected = lock.names.filter((name) => !isKnownEntry(name));
  if (unexpected.length > 0) return `the lock directory holds unexpected entries (${unexpected.join(", ")}); ${remedy}`;
  const holder = lock.owners.find((entry) => entry.owner !== undefined)?.owner;
  if (holder !== undefined) return `held by pid ${holder.pid} on ${holder.host}; ${remedy}`;
  return `the lock directory names no owner; ${remedy}`;
}

type Ownership = "held" | "lost" | "unsettled";

async function ownership(lockPath: string, owner: LockOwner): Promise<Ownership> {
  let names: string[];
  try {
    names = await fs.readdir(lockPath);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return "lost";
    if (TRANSIENT_CODES.has(code)) return "unsettled";
    throw error;
  }
  let unsettled = false;
  for (const name of names.filter(isOwnerFile)) {
    try {
      if (parseOwner(await fs.readFile(path.join(lockPath, name), "utf8"))?.token === owner.token) return "held";
    } catch (error) {
      if (!TRANSIENT_CODES.has(errorCode(error))) throw error;
      unsettled = true;
    }
  }
  return unsettled ? "unsettled" : "lost";
}

function ownsSync(lockPath: string, owner: LockOwner): boolean {
  for (const name of readdirSync(lockPath).filter(isOwnerFile)) {
    try {
      if (parseOwner(readFileSync(path.join(lockPath, name), "utf8"))?.token === owner.token) return true;
    } catch { /* a file set aside or removed this instant: look at the next one */ }
  }
  return false;
}

async function releaseOwnedLock(lockPath: string, owner: LockOwner): Promise<void> {
  ownedLocks.delete(lockPath);
  const ownershipLost = (): IndexingError => new IndexingError({ phase: "cache", path: lockPath, code: "cache-lock-ownership-lost" });
  const deadline = performance.now() + 1000;
  let state = await ownership(lockPath, owner);
  while (state === "unsettled" && performance.now() < deadline) {
    await delay(5);
    state = await ownership(lockPath, owner);
  }
  if (state !== "held") throw ownershipLost();
  // Moving the whole directory aside is the release, and only its owner may do it. Removing the
  // owner file first would leave, for as long as it takes to remove the directory, a lock that
  // names no owner.
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
// lock it was still waiting for, synchronously, so no cache operation of this process can
// interleave with the release.
export function releaseHeldCacheLocksSync(): void {
  for (const staged of stagedLocks) {
    try { rmSync(staged, { recursive: true, force: true }); } catch { /* exiting: best effort */ }
  }
  stagedLocks.clear();
  for (const [lockPath, owner] of ownedLocks) {
    try {
      if (!ownsSync(lockPath, owner)) continue;
      const released = `${lockPath}.released-${owner.token}`;
      renameSync(lockPath, released);
      rmSync(released, { recursive: true, force: true });
    } catch { /* exiting: an unreleased lock names this dead process and is recovered */ }
  }
  ownedLocks.clear();
}

const DEBRIS_RE = /\.(?:acquire|released|abandoned)-[0-9a-f-]{36}$/;

// A process killed while a lock directory sits under a private staged, released or abandoned name
// leaves that directory behind. It blocks nothing, and it is removed here once every owner named in
// it has exited, or, when it names none, once it has been quiet for the grace period.
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
    const state = await snapshot(debris).catch(() => undefined);
    if (state === undefined || !state.settled) continue;
    const owners = state.owners.flatMap((entry) => entry.owner === undefined ? [] : [entry.owner]);
    const gone = owners.length > 0 ? owners.every(lockOwnerExited) : quietSince(state.mtimeMs);
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
    await fs.writeFile(path.join(staged, OWNER_FILE), JSON.stringify(owner), { flag: "wx" });
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
        await reclaimAbandonedLock(lockPath);
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
