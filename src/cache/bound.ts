import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
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
// run makes an anchor: an empty directory under a random name in the cache directory, and every cacheFs call on a path
// within it goes through <cache>/<anchor>/.., which the kernel resolves through the anchor's own parent. A call sent
// into any other directory finds no anchor there and fails with ENOENT before it changes anything. A change that fails
// with ENOENT is checked against the cache directory through the anchor, and fails with cache-changing when what it
// found missing is there. Node's recursive mkdir and rm compose paths of their own, so a recursive mkdir creates each
// directory in turn, and a recursive rm first moves its target into the anchor. Every change is also checked before
// and after against the cache directory's identity, which stops a run once a retarget stays in place. What remains
// unbound is the creation of the anchor itself: a retarget at that moment leaves one empty directory under the random
// name elsewhere, and the run fails. An anchor is left behind when the run ends after the cache directory moved, or
// when the process dies. Where .. drops the name before it instead, as Windows resolves it, no anchor can bind the
// directory, and every change is only checked before and after: a retarget during one call can still send that call,
// and only that call, into the other directory, and one undone between two checks is not seen.
interface Scope {
  readonly dir: string;
  readonly prefix: string;
  readonly identity: string;
}

interface Bound extends Scope {
  readonly via: string;
}

interface Handle extends Bound {
  readonly file: FileHandle;
  users: number;
}

interface Anchor extends Bound {
  readonly anchor: string;
}

// live ends with the operation, so a call that outlives it, from work the operation started without awaiting, uses the
// path as given rather than a descriptor that may since have closed and been reused, or an anchor since removed. A run
// without either is checked.
const binding = new AsyncLocalStorage<{ readonly scope: Scope; readonly handle: Handle | Anchor | undefined; live: boolean }>();
// Kept open between refreshes, so a refresh of a cache directory already open compares the stat ensureCacheDir took with
// it and opens nothing. A handle in use is never closed; one no longer the directory's handle closes with its last user.
// The registry is one per process: a module loaded again, as a test runner does for each file, would otherwise drop
// handles still open, and Node treats a FileHandle collected while open as an error.
const registry = Symbol.for("osnova.boundCacheHandles");
const shared = globalThis as typeof globalThis & { [registry]?: Map<string, Handle> | undefined };
const handles = shared[registry] ??= new Map<string, Handle>();
const keptHandles = 4;
let unsupported = process.platform !== "linux";
// Whether .. resolves through the directory before it, probed by the first run that needs an anchor.
let physicalParent: boolean | undefined;

const identityOf = (stat: { readonly dev: bigint; readonly ino: bigint }): string => `${stat.dev}:${stat.ino}`;
const prefixOf = (dir: string): string => dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`;
const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;
const changingIn = (scope: Scope): IndexingError => new IndexingError({ phase: "cache", path: scope.dir, code: "cache-changing" });

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

async function anchorIn(scope: Scope): Promise<Anchor | undefined> {
  const anchor = `${scope.prefix}.osnova-bound-${randomUUID()}`;
  const via = `${anchor}${path.sep}..`;
  physicalParent ??= await promises.stat(via).then(() => false, (error: unknown) => codeOf(error) === "ENOENT" ? true : undefined);
  if (physicalParent !== true) return undefined;
  await ensureSame(scope);
  try {
    await promises.mkdir(anchor);
  } catch (error) {
    throw new IndexingError({ phase: "cache", path: scope.dir, code: "cache-write-failed" }, error);
  }
  if (await promises.stat(via, { bigint: true }).then(identityOf, () => undefined) !== scope.identity) {
    await promises.rmdir(anchor).catch(() => {});
    throw changingIn(scope);
  }
  return { ...scope, via, anchor };
}

// The path names the anchor itself, so wherever it resolves, this removes nothing but the anchor.
async function removeAnchor(anchor: Anchor): Promise<void> {
  await promises.rmdir(anchor.anchor).catch(async (error: unknown) => {
    if (codeOf(error) === "ENOTEMPTY" || codeOf(error) === "EEXIST") await promises.rm(anchor.anchor, { recursive: true, force: true }).catch(() => {});
  });
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
// the given identity, the one ensureCacheDir found. A directory that path no longer names fails the operation. Where no
// descriptor can bind the directory, an anchor binds it, or each change within it is checked, as described above.
export async function withBoundCacheDir<T>(canonicalCache: string, identity: string, operation: () => Promise<T>): Promise<T> {
  let handle = unsupported ? undefined : handles.get(canonicalCache);
  if (!unsupported && (handle === undefined || handle.identity !== identity)) handle = await open(canonicalCache, identity);
  if (handle === undefined) {
    const scope = { dir: canonicalCache, prefix: prefixOf(canonicalCache), identity };
    const anchor = await anchorIn(scope);
    const checked = { scope, handle: anchor, live: true };
    try {
      return await binding.run(checked, operation);
    } finally {
      checked.live = false;
      if (anchor !== undefined) await removeAnchor(anchor);
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
  if (seen !== scope.identity) throw changingIn(scope);
}

// Joined as text, since path.join would drop an anchor's .. together with the anchor.
function bound(handle: Bound, target: unknown): unknown {
  if (typeof target !== "string") return target;
  const absolute = path.resolve(target);
  if (absolute === handle.dir) return handle.via;
  return absolute.startsWith(handle.prefix) ? `${handle.via}${path.sep}${absolute.slice(handle.prefix.length)}` : target;
}

function restored(handle: Bound, value: string): string {
  return value === handle.via || value.startsWith(`${handle.via}${path.sep}`) ? `${handle.dir}${value.slice(handle.via.length)}` : value;
}

function unbound(handle: Bound, error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const named = error as NodeJS.ErrnoException & { dest?: string | undefined };
  if (typeof named.path === "string") named.path = restored(handle, named.path);
  if (typeof named.dest === "string") named.dest = restored(handle, named.dest);
  // A descriptor's path is a prefix of other descriptors' paths, so only a quoted one is replaced; an anchor's is unique.
  named.message = "anchor" in handle
    ? named.message.split(handle.via).join(handle.dir)
    : named.message.split(`'${handle.via}`).join(`'${handle.dir}`);
  return error;
}

type Promises = typeof promises;
type Bindable = "access" | "copyFile" | "lstat" | "mkdir" | "readFile" | "readdir" | "rename" | "rm" | "rmdir" | "stat" | "unlink" | "writeFile";
const changes = new Set<Bindable>(["copyFile", "mkdir", "rename", "rm", "rmdir", "unlink", "writeFile"]);

type Call = (...args: unknown[]) => Promise<unknown>;

// Whether target is missing from the cache directory, read through the anchor. A listing that cannot be read while its
// own parent lists it fails with cache-changing: the read went elsewhere. Outside the cache directory only its
// ancestors are known to exist.
async function absentIn(anchor: Anchor, target: string): Promise<boolean> {
  if (target === anchor.dir) return false;
  if (!within(anchor, target)) return !anchor.dir.startsWith(prefixOf(target));
  const parent = path.dirname(target);
  try {
    return !(await promises.readdir(bound(anchor, parent) as string)).includes(path.basename(target));
  } catch (error) {
    if (codeOf(error) === "ENOTDIR") return true;
    if (codeOf(error) !== "ENOENT") throw unbound(anchor, error);
    if (await absentIn(anchor, parent)) return true;
    throw changingIn(anchor);
  }
}

// What a change through the anchor that failed with error throws: what it reports missing must be missing from the
// cache directory, or the change went elsewhere.
async function missingIn(anchor: Anchor, name: Bindable, targets: readonly string[], error: unknown): Promise<unknown> {
  if (codeOf(error) !== "ENOENT") return error;
  const [first = anchor.dir, second = anchor.dir] = targets;
  let missing: boolean;
  if (name === "writeFile" || name === "mkdir") missing = await absentIn(anchor, path.dirname(first));
  else if (name === "rename" || name === "copyFile") missing = await absentIn(anchor, first) || await absentIn(anchor, path.dirname(second));
  else missing = await absentIn(anchor, first);
  return missing ? error : changingIn(anchor);
}

async function calling(handle: Bound, name: Bindable, call: Call, args: unknown[], paths: number): Promise<unknown> {
  for (let index = 0; index < paths; index += 1) args[index] = bound(handle, args[index]);
  let result: unknown;
  try {
    result = await call(...args);
  } catch (error) {
    throw unbound(handle, error);
  }
  return name === "mkdir" && typeof result === "string" ? restored(handle, result) : result;
}

// Node's recursive mkdir creates a missing parent by the dirname of the path it was given, which would create the
// anchor wherever that path resolves, so each directory is created in turn. Like Node's, it returns the first it created.
async function mkdirs(anchor: Anchor, call: Call, target: string, options: object): Promise<string | undefined> {
  const single = { ...options, recursive: false };
  const make = async (dir: string, last: boolean): Promise<boolean> => {
    try {
      await call(bound(anchor, dir), single);
      return true;
    } catch (error) {
      if (codeOf(error) === "EEXIST" && (!last || await promises.stat(bound(anchor, dir) as string).then((stat) => stat.isDirectory(), () => false))) return false;
      throw await missingIn(anchor, "mkdir", [dir], unbound(anchor, error));
    }
  };
  try {
    return await make(target, true) ? target : undefined;
  } catch (error) {
    if (codeOf(error) !== "ENOENT") throw error;
  }
  const names = target.slice(anchor.prefix.length).split(path.sep);
  let first: string | undefined;
  for (let depth = 1; depth <= names.length; depth += 1) {
    const dir = `${anchor.prefix}${names.slice(0, depth).join(path.sep)}`;
    if (await make(dir, depth === names.length)) first ??= dir;
  }
  return first;
}

// Node's recursive rm reaches what a directory holds by path.join, which drops the anchor, so the target is first moved
// into the anchor and removed there. A missing target is only taken as missing once the cache directory lacks it.
async function remove(anchor: Anchor, call: Call, target: string, options: unknown): Promise<void> {
  const given = (typeof options === "object" && options !== null ? options : {}) as { readonly force?: boolean | undefined; readonly recursive?: boolean | undefined };
  // Settles a failure of the first step: a missing target is done when forced, and anything else is thrown.
  const missing = async (error: unknown, reported: () => Promise<unknown>): Promise<void> => {
    if (codeOf(error) !== "ENOENT") throw unbound(anchor, error);
    if (!(await absentIn(anchor, target))) throw changingIn(anchor);
    if (given.force !== true) throw await reported();
  };
  if (given.recursive !== true) {
    await call(bound(anchor, target), { ...given, force: false }).catch(async (error: unknown) => await missing(error, async () => unbound(anchor, error)));
    return;
  }
  const trash = `${anchor.anchor}${path.sep}${randomUUID()}`;
  // rm itself reports a missing target with the error lstat gives.
  const reported = async (): Promise<unknown> => await promises.lstat(bound(anchor, target) as string).then(() => changingIn(anchor), (error: unknown) => unbound(anchor, error));
  const moved = await promises.rename(bound(anchor, target) as string, trash).then(() => true, async (error: unknown) => {
    await missing(error, reported);
    return false;
  });
  if (moved) await call(trash, { ...given, force: true });
}

async function changeThrough(anchor: Anchor, name: Bindable, call: Call, args: unknown[], paths: number): Promise<unknown> {
  const targets = args.slice(0, paths).map((target) => path.resolve(String(target)));
  const [target = anchor.dir] = targets;
  const options = args[1];
  if (name === "mkdir" && typeof options === "object" && options !== null && (options as { recursive?: unknown }).recursive === true) {
    return await mkdirs(anchor, call, target, options);
  }
  if (name === "rm") return await remove(anchor, call, target, options);
  try {
    return await calling(anchor, name, call, args, paths);
  } catch (error) {
    throw await missingIn(anchor, name, targets, error);
  }
}

// The method is looked up on each call, so whatever replaces it on the promises API sees the call.
function through<K extends Bindable>(name: K, paths: 1 | 2): Promises[K] {
  return (async (...args: unknown[]) => {
    const call = promises[name] as Call;
    const run = binding.getStore();
    if (run?.live !== true) return await call(...args);
    const handle = run.handle;
    if (handle !== undefined && !("anchor" in handle)) return await calling(handle, name, call, args, paths);
    if (!changes.has(name) || !args.slice(0, paths).some((target) => within(run.scope, target))) {
      return handle === undefined ? await call(...args) : await calling(handle, name, call, args, paths);
    }
    await ensureSame(run.scope);
    const change = handle === undefined ? call(...args) : changeThrough(handle, name, call, args, paths);
    const settled = await change.then((value) => ({ value }), (error: unknown) => ({ error }));
    await ensureSame(run.scope);
    if ("error" in settled) throw settled.error;
    return settled.value;
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
