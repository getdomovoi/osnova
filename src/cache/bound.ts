import { AsyncLocalStorage } from "node:async_hooks";
import { constants, promises } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { IndexingError } from "../index/diagnostics.js";

// Node has no directory-relative file operations, so a cache path is resolved again by every call, and a parent
// retargeted between two calls sends the second into another cache directory, whose locks this process does not hold.
// On Linux, /proc/self/fd/<n> names the directory an open descriptor refers to wherever it has moved, so a path below
// it reaches that directory without resolving the cache directory's ancestors again. Inside withBoundCacheDir every
// cacheFs call on a path within the cache directory goes through such a descriptor; elsewhere cacheFs calls the path as
// given. Paths kept in indexes and errors still name the cache directory itself.
// Where no descriptor can bind the cache directory, on platforms without /proc/self/fd or where its probe fails, the
// guarantee is weaker: every cacheFs call inside withBoundCacheDir that changes a path within the cache directory stats
// the cache directory before and after the call and fails with cache-changing when it is not the directory the
// identity names, so a retarget seen by either check stops the operation before its next write. A retarget during one
// call can still send that call, and only that call, into the other directory, and one undone between two checks is
// not seen. Reads are not checked.
interface Scope {
  readonly dir: string;
  readonly prefix: string;
  readonly identity: string;
}

interface Handle extends Scope {
  readonly via: string;
  readonly file: FileHandle;
  users: number;
}

// live ends with the operation, so a call that outlives it, from work the operation started without awaiting, uses the
// path as given rather than a descriptor that may since have closed and been reused. A run without a handle is checked.
const binding = new AsyncLocalStorage<{ readonly scope: Scope; readonly handle: Handle | undefined; live: boolean }>();
// Kept open between refreshes, so a refresh of a cache directory already open compares the stat ensureCacheDir took with
// it and opens nothing. A handle in use is never closed; one no longer the directory's handle closes with its last user.
// The registry is one per process: a module loaded again, as a test runner does for each file, would otherwise drop
// handles still open, and Node treats a FileHandle collected while open as an error.
const registry = Symbol.for("osnova.boundCacheHandles");
const shared = globalThis as typeof globalThis & { [registry]?: Map<string, Handle> | undefined };
const handles = shared[registry] ??= new Map<string, Handle>();
const keptHandles = 4;
let unsupported = process.platform !== "linux";

const identityOf = (stat: { readonly dev: bigint; readonly ino: bigint }): string => `${stat.dev}:${stat.ino}`;
const prefixOf = (dir: string): string => dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`;

function close(handle: Handle): void {
  void handle.file.close().catch(() => {});
}

function release(handle: Handle): void {
  handle.users -= 1;
  if (handle.users === 0 && handles.get(handle.dir) !== handle) close(handle);
}

function keep(handle: Handle): void {
  const previous = handles.get(handle.dir);
  handles.delete(handle.dir);
  handles.set(handle.dir, handle);
  if (previous !== undefined && previous !== handle && previous.users === 0) close(previous);
  for (const [dir, kept] of handles) {
    if (handles.size <= keptHandles) break;
    if (kept.users > 0) continue;
    handles.delete(dir);
    close(kept);
  }
}

async function open(dir: string, identity: string): Promise<Handle | undefined> {
  const file = await promises.open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    if (identityOf(await file.stat({ bigint: true })) !== identity) {
      throw new IndexingError({ phase: "cache", path: dir, code: "cache-changing" });
    }
    const via = `/proc/self/fd/${file.fd}`;
    const seen = await promises.stat(via, { bigint: true }).then(identityOf, () => undefined);
    if (seen !== identity) {
      unsupported = true;
      await file.close();
      return undefined;
    }
    return { dir, prefix: prefixOf(dir), via, identity, file, users: 0 };
  } catch (error) {
    await file.close().catch(() => {});
    throw error;
  }
}

// Creates the cache directory when it is missing and returns the device and inode of the directory it names. The stat
// takes the place of the existence check a recursive mkdir makes, so a cache directory already there costs no more.
export async function ensureCacheDir(cacheDir: string): Promise<string> {
  try {
    const stat = await promises.stat(cacheDir, { bigint: true }).catch(async (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await promises.mkdir(cacheDir, { recursive: true });
      return await promises.stat(cacheDir, { bigint: true });
    });
    if (!stat.isDirectory()) throw new Error("cache directory is not a directory");
    return identityOf(stat);
  } catch (error) {
    throw new IndexingError({ phase: "cache", path: cacheDir, code: "cache-write-failed" }, error);
  }
}

// Runs operation with every cacheFs call on a path within the canonical cache directory bound to the directory with
// the given identity, the one ensureCacheDir found. A directory that path no longer names fails the operation. Where the
// directory cannot be bound, each change within it is checked against the identity instead, as described above.
export async function withBoundCacheDir<T>(canonicalCache: string, identity: string, operation: () => Promise<T>): Promise<T> {
  let handle = unsupported ? undefined : handles.get(canonicalCache);
  if (!unsupported && (handle === undefined || handle.identity !== identity)) handle = await open(canonicalCache, identity);
  if (handle === undefined) {
    const checked = { scope: { dir: canonicalCache, prefix: prefixOf(canonicalCache), identity }, handle, live: true };
    try {
      return await binding.run(checked, operation);
    } finally {
      checked.live = false;
    }
  }
  handle.users += 1;
  keep(handle);
  const run = { scope: handle, handle, live: true };
  try {
    return await binding.run(run, operation);
  } finally {
    run.live = false;
    release(handle);
  }
}

// The cache-changing failure behind a write failure that wraps it, so a caller sees that the cache directory moved.
export function cacheChangingIn(error: unknown): IndexingError | undefined {
  let cause: unknown = error;
  for (let depth = 0; depth < 8 && cause !== null && cause !== undefined; depth += 1) {
    if (cause instanceof IndexingError && cause.diagnostic.code === "cache-changing") return cause;
    cause = (cause as { cause?: unknown }).cause;
  }
  return undefined;
}

function within(scope: Scope, target: unknown): boolean {
  if (typeof target !== "string") return false;
  const absolute = path.resolve(target);
  return absolute === scope.dir || absolute.startsWith(scope.prefix);
}

async function ensureSame(scope: Scope): Promise<void> {
  const seen = await promises.stat(scope.dir, { bigint: true }).then(identityOf, () => undefined);
  if (seen !== scope.identity) throw new IndexingError({ phase: "cache", path: scope.dir, code: "cache-changing" });
}

function bound(handle: Handle, target: unknown): unknown {
  if (typeof target !== "string") return target;
  const absolute = path.resolve(target);
  if (absolute === handle.dir) return handle.via;
  return absolute.startsWith(handle.prefix) ? path.join(handle.via, absolute.slice(handle.prefix.length)) : target;
}

function restored(handle: Handle, value: string): string {
  return value === handle.via || value.startsWith(`${handle.via}${path.sep}`) ? `${handle.dir}${value.slice(handle.via.length)}` : value;
}

function unbound(handle: Handle, error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const named = error as NodeJS.ErrnoException & { dest?: string | undefined };
  if (typeof named.path === "string") named.path = restored(handle, named.path);
  if (typeof named.dest === "string") named.dest = restored(handle, named.dest);
  named.message = named.message.split(`'${handle.via}`).join(`'${handle.dir}`);
  return error;
}

type Promises = typeof promises;
type Bindable = "access" | "copyFile" | "lstat" | "mkdir" | "readFile" | "readdir" | "rename" | "rm" | "rmdir" | "stat" | "unlink" | "writeFile";
const changes = new Set<Bindable>(["copyFile", "mkdir", "rename", "rm", "rmdir", "unlink", "writeFile"]);

// The method is looked up on each call, so whatever replaces it on the promises API sees the call.
function through<K extends Bindable>(name: K, paths: 1 | 2): Promises[K] {
  return (async (...args: unknown[]) => {
    const call = promises[name] as (...args: unknown[]) => Promise<unknown>;
    const run = binding.getStore();
    if (run?.live !== true) return await call(...args);
    const handle = run.handle;
    if (handle === undefined) {
      if (!changes.has(name) || !args.slice(0, paths).some((target) => within(run.scope, target))) return await call(...args);
      await ensureSame(run.scope);
      const settled = await call(...args).then((value) => ({ value }), (error: unknown) => ({ error }));
      await ensureSame(run.scope);
      if ("error" in settled) throw settled.error;
      return settled.value;
    }
    for (let index = 0; index < paths; index += 1) args[index] = bound(handle, args[index]);
    let result: unknown;
    try {
      result = await call(...args);
    } catch (error) {
      throw unbound(handle, error);
    }
    return name === "mkdir" && typeof result === "string" ? restored(handle, result) : result;
  }) as Promises[K];
}

export const cacheFs = {
  access: through("access", 1),
  copyFile: through("copyFile", 2),
  lstat: through("lstat", 1),
  mkdir: through("mkdir", 1),
  readFile: through("readFile", 1),
  readdir: through("readdir", 1),
  rename: through("rename", 2),
  rm: through("rm", 1),
  rmdir: through("rmdir", 1),
  stat: through("stat", 1),
  unlink: through("unlink", 1),
  writeFile: through("writeFile", 1),
  constants,
};
