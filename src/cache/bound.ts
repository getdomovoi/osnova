import { AsyncLocalStorage } from "node:async_hooks";
import childProcess, { type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, promises, rmdirSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type { Socket } from "node:net";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { IndexingError } from "../index/diagnostics.js";

// Node has no directory-relative file operations, so a cache path is resolved again by every call, and a parent
// retargeted between two calls sends the second into another cache directory, whose locks this process does not hold.
// On Linux, /proc/self/fd/<n> names the directory an open descriptor refers to wherever it has moved, so a path below
// it reaches that directory without resolving the cache directory's ancestors again. Inside withBoundCacheDir every
// cacheFs call on a path within the cache directory goes through such a descriptor; elsewhere cacheFs calls the path as
// given. Paths kept in indexes and errors still name the cache directory itself.
// Where no descriptor can bind the cache directory, on platforms without /proc/self/fd or where its probe fails, the
// first run of a process makes an anchor, which later runs reuse: an empty directory under a random name in the cache
// directory, and every cacheFs call on a path within it goes through <cache>/<anchor>/.., which the kernel resolves
// through the anchor's own parent. A call sent into any other directory finds no anchor there and fails with ENOENT
// before it changes anything. A change that fails with ENOENT is checked against the cache directory through the
// anchor, and fails with cache-changing when what it found missing is there. Node's recursive mkdir and rm compose
// paths of their own, so a recursive mkdir creates each directory in turn, and a recursive rm first moves its target
// into the anchor. Node's rm also takes a path it finds missing once it has found its target as removed, so an rm
// deletes by calls that report a missing path instead. Every change is also checked before and after against the
// cache directory's identity, which stops a run once a retarget stays in place. A new anchor is made by a helper
// process whose working directory is the cache directory, relative to it, so it is bound as well. The helper then
// enters the anchor and stays there, and removes each tree moved into it directory by directory, entering each one,
// so a directory swapped for a link sends no removal outside the tree; the helper empties an anchor the same way before
// it is removed. A run that finds the cache directory moved, or the anchor gone, drops the anchor, so the next run makes
// a new one. An anchor is left behind when it is dropped after the cache directory moved, when its helper cannot remove
// what it holds, when it holds anything as the process exits, or when the process dies without exiting. Where .. drops
// the name before it instead, as Windows resolves it, Node offers no way to bind the directory, and a worker thread makes
// no anchor, so there every change within the cache directory fails with cache-unbindable before it changes anything;
// reads go by path.
interface Scope {
  readonly dir: string;
  readonly prefix: string;
  readonly identity: string;
}

interface Bound extends Scope {
  readonly via: string;
}

interface Kept extends Bound {
  users: number;
}

interface Handle extends Kept {
  readonly file: FileHandle;
}

interface Helper {
  readonly child: ChildProcessWithoutNullStreams;
  readonly answers: Array<(answer: string | undefined) => void>;
  closed: boolean;
}

interface Anchor extends Kept {
  readonly anchor: string;
  helper: Promise<Helper> | undefined;
}

// live ends with the operation, so a call that outlives it, from work the operation started without awaiting, uses the
// path as given rather than a descriptor that may since have closed and been reused, or an anchor since removed. A run
// without either refuses every change within the cache directory.
const binding = new AsyncLocalStorage<{ readonly scope: Scope; readonly handle: Handle | Anchor | undefined; live: boolean }>();
// Kept open between refreshes, so a refresh of a cache directory already open compares the stat ensureCacheDir took with
// it and opens nothing. A handle in use is never closed; one no longer the directory's handle closes with its last user.
// Anchors are kept the same way, so a refresh of a cache directory already anchored makes no anchor; each is removed
// once displaced and unused, or, if empty, as the process exits. The registries are one per process: a module loaded
// again, as a test runner does for each file, would otherwise drop handles still open, and Node treats a FileHandle
// collected while open as an error.
const registry = Symbol.for("osnova.boundCacheHandles");
const anchorRegistry = Symbol.for("osnova.boundCacheAnchors");
const shared = globalThis as typeof globalThis & {
  [registry]?: Map<string, Handle> | undefined;
  [anchorRegistry]?: Map<string, Anchor> | undefined;
};
const handles = shared[registry] ??= new Map<string, Handle>();
const anchors = shared[anchorRegistry] ??= removedOnExit(new Map<string, Anchor>());
const keptHandles = 4;
let unsupported = process.platform !== "linux";
// Whether .. resolves through the directory before it, probed by the first run that needs an anchor.
let physicalParent: boolean | undefined;

const identityOf = (stat: { readonly dev: bigint; readonly ino: bigint }): string => `${stat.dev}:${stat.ino}`;
const prefixOf = (dir: string): string => dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`;
const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

// A kept anchor through which a call found its cache directory moved, or the anchor missing, is no longer kept, so the
// next run makes a new one.
function changingIn(scope: Scope): IndexingError {
  if (anchors.get(scope.dir) === scope) anchors.delete(scope.dir);
  return new IndexingError({ phase: "cache", path: scope.dir, code: "cache-changing" });
}

function close(handle: Handle): void {
  void handle.file.close().catch(() => {});
}

function release<T extends Kept, R>(registered: Map<string, T>, item: T, dispose: (item: T) => R): R | undefined {
  item.users -= 1;
  return item.users === 0 && registered.get(item.dir) !== item ? dispose(item) : undefined;
}

function keep<T extends Kept>(registered: Map<string, T>, item: T, dispose: (item: T) => unknown): void {
  const previous = registered.get(item.dir);
  registered.delete(item.dir);
  registered.set(item.dir, item);
  if (previous !== undefined && previous !== item && previous.users === 0) dispose(previous);
  for (const [dir, kept] of registered) {
    if (registered.size <= keptHandles) break;
    if (kept.users > 0) continue;
    registered.delete(dir);
    dispose(kept);
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

// The exit code of a helper that found its working directory not to be the cache directory, or the anchor not to be
// the directory it entered.
const elsewhereExit = 3;
// Started in the cache directory, makes the anchor there, or finds it, by its name alone, once "." has the cache
// directory's identity, enters it, and writes an empty line. Each line it then reads names a tree moved into the anchor,
// which it removes, or is empty, and it removes all the anchor holds, answering with a line of JSON. Each directory of
// the tree is entered and found to be the one an lstat just found there, so a directory replaced, or swapped for a link,
// before it is entered stops the removal before it changes anything there, and what is removed is named relative to the
// directory entered, so no link is followed. A helper that cannot find its way back into the anchor answers and exits.
const serveAnchor = [
  `const fs = require("node:fs");`,
  `const [name, mode, identity] = process.argv.slice(1);`,
  `const identityOf = (stat) => \`\${stat.dev}:\${stat.ino}\`;`,
  `const here = () => identityOf(fs.statSync(".", { bigint: true }));`,
  `const elsewhere = new Error("elsewhere");`,
  `const enter = (dir, expected) => {`,
  `  try { process.chdir(dir); } catch { throw elsewhere; }`,
  `  if (here() !== expected) throw elsewhere;`,
  `};`,
  `if (here() !== identity) process.exit(${elsewhereExit});`,
  `if (mode === "make") fs.mkdirSync(name);`,
  `const entered = [];`,
  `try {`,
  `  const found = fs.lstatSync(name, { bigint: true });`,
  `  if (!found.isDirectory()) throw elsewhere;`,
  `  enter(name, identityOf(found));`,
  `  entered.push(identityOf(found));`,
  `} catch {`,
  `  process.exit(${elsewhereExit});`,
  `}`,
  `const at = [];`,
  `const remove = (entry) => {`,
  `  at.push(entry);`,
  `  const found = fs.lstatSync(entry, { bigint: true });`,
  `  if (found.isDirectory()) {`,
  `    enter(entry, identityOf(found));`,
  `    entered.push(identityOf(found));`,
  `    for (const inner of fs.readdirSync(".")) remove(inner);`,
  `    entered.pop();`,
  `    enter("..", entered.at(-1));`,
  `    fs.rmdirSync(entry);`,
  `  } else fs.unlinkSync(entry);`,
  `  at.pop();`,
  `};`,
  `const answer = (staged) => {`,
  `  at.length = 0;`,
  `  try {`,
  `    for (const entry of staged === "" ? fs.readdirSync(".") : [staged]) remove(entry);`,
  `    return {};`,
  `  } catch (error) {`,
  `    const failed = error === elsewhere ? { elsewhere: true } : { code: error.code, errno: error.errno, syscall: error.syscall, path: error.path, message: error.message, at };`,
  `    try {`,
  `      while (entered.length > 1) {`,
  `        entered.pop();`,
  `        enter("..", entered.at(-1));`,
  `      }`,
  `      if (here() !== entered[0]) throw elsewhere;`,
  `    } catch {`,
  `      failed.lost = true;`,
  `    }`,
  `    return failed;`,
  `  }`,
  `};`,
  `let buffered = "";`,
  `process.stdin.setEncoding("utf8");`,
  `process.stdin.on("data", (chunk) => {`,
  `  buffered += chunk;`,
  `  for (let end = buffered.indexOf("\\n"); end >= 0; end = buffered.indexOf("\\n")) {`,
  `    const reply = answer(buffered.slice(0, end));`,
  `    buffered = buffered.slice(end + 1);`,
  `    if (reply.lost !== true) {`,
  `      process.stdout.write(JSON.stringify(reply) + "\\n");`,
  `      continue;`,
  `    }`,
  `    process.stdin.pause();`,
  `    process.stdout.write(JSON.stringify(reply) + "\\n", () => process.exit(${elsewhereExit}));`,
  `    return;`,
  `  }`,
  `});`,
  `process.stdout.write("\\n");`,
].join("\n");

// A helper needs no setting Node reads from a NODE_ variable, and one naming a relative path, as a preload in
// NODE_OPTIONS may, would resolve from the cache directory rather than from the working directory it was written for.
function helperEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("NODE_")));
}

// The helper keeps this process alive only while it owes an answer, and exits once this process closes its input.
function waiting(helper: Helper): void {
  const streams = [helper.child.stdout, helper.child.stderr, helper.child.stdin] as unknown as readonly Socket[];
  if (helper.answers.length > 0) streams[0]?.ref();
  else for (const stream of streams) stream.unref();
}

// Starts the helper of anchor, as anchor.helper until it exits. A helper that exits before it is ready fails as the
// cache directory moved when it found the cache directory or the anchor elsewhere.
function serve(anchor: Anchor, mode: "make" | "enter"): Promise<Helper> {
  const started = new Promise<Helper>((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, ["-e", serveAnchor, path.basename(anchor.anchor), mode, anchor.identity], { cwd: anchor.dir, env: helperEnv(), stdio: "pipe", windowsHide: true });
    const helper: Helper = { child, answers: [], closed: false };
    let ready = false;
    let buffered = "";
    let stderr = "";
    const settle = (cause: () => unknown): void => {
      helper.closed = true;
      if (anchor.helper === started) anchor.helper = undefined;
      for (const answer of helper.answers.splice(0)) answer(undefined);
      if (!ready) reject(cause());
    };
    child.unref();
    child.stdin.on("error", () => {});
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 4096) stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        if (ready) helper.answers.shift()?.(line);
        ready = true;
        waiting(helper);
        resolve(helper);
      }
    });
    child.on("error", (error) => settle(() => new IndexingError({ phase: "cache", path: anchor.dir, code: "cache-write-failed" }, error)));
    child.on("close", (code, signal) => settle(() => code === elsewhereExit ? changingIn(anchor)
      : new IndexingError({ phase: "cache", path: anchor.dir, code: "cache-write-failed" }, new Error(`the anchor helper exited with ${code ?? signal}: ${stderr}`))));
  });
  anchor.helper = started;
  return started;
}

// The answer of the helper of anchor to line, or undefined when it exits first.
async function ask(anchor: Anchor, line: string): Promise<string | undefined> {
  const helper = await (anchor.helper ?? serve(anchor, "enter"));
  if (helper.closed) return undefined;
  return await new Promise<string | undefined>((resolve) => {
    helper.answers.push(resolve);
    waiting(helper);
    helper.child.stdin.write(`${line}\n`);
  });
}

// Besides a descriptor, the working directory is the one reference to a directory that the kernel resolves a relative
// path from without resolving that directory's ancestors again. This process could only enter its own working directory
// again by the path it had, which a retarget or removal can leave naming another directory or none, so a helper process
// started in the cache directory makes the anchor and stays in it. The anchor lands in the cache directory or nowhere,
// and this process's working directory never changes. A worker thread makes no anchor: one terminated runs no exit
// handler, so its anchors would stay behind.
async function anchorIn(scope: Scope): Promise<Anchor | undefined> {
  const name = `.osnova-bound-${randomUUID()}`;
  const anchor = `${scope.prefix}${name}`;
  const via = `${anchor}${path.sep}..`;
  physicalParent ??= await promises.stat(via).then(() => false, (error: unknown) => codeOf(error) === "ENOENT" ? true : undefined);
  if (physicalParent !== true || !isMainThread) return undefined;
  await ensureSame(scope);
  const made: Anchor = { ...scope, via, anchor, users: 0, helper: undefined };
  await serve(made, "make");
  return made;
}

// The path names the anchor itself, so wherever it resolves, this removes nothing but the anchor. What a failed removal
// left in it, its helper removes first, as it removes a tree moved into it; an anchor it cannot empty stays behind. Its
// helper exits once its input is closed.
async function removeAnchor(anchor: Anchor): Promise<void> {
  await promises.rmdir(anchor.anchor).catch(async (error: unknown) => {
    if (codeOf(error) !== "ENOTEMPTY" && codeOf(error) !== "EEXIST") return;
    if (await ask(anchor, "").then((answer) => answer === "{}", () => false)) await promises.rmdir(anchor.anchor).catch(() => {});
  });
  void anchor.helper?.then((helper) => helper.child.stdin.end(), () => {});
}

function removedOnExit(kept: Map<string, Anchor>): Map<string, Anchor> {
  process.once("exit", () => {
    for (const anchor of kept.values()) {
      // Exiting leaves no time to ask the helper, so an anchor that still holds anything stays behind.
      try { rmdirSync(anchor.anchor); } catch { /* exiting: the anchor stays behind */ }
    }
  });
  return kept;
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
// descriptor can bind the directory, an anchor binds it, or each change within it is refused, as described above.
export async function withBoundCacheDir<T>(canonicalCache: string, identity: string, operation: () => Promise<T>): Promise<T> {
  let handle = unsupported ? undefined : handles.get(canonicalCache);
  if (!unsupported && (handle === undefined || handle.identity !== identity)) handle = await open(canonicalCache, identity);
  if (handle === undefined) {
    const scope = { dir: canonicalCache, prefix: prefixOf(canonicalCache), identity };
    let anchor = anchors.get(canonicalCache);
    if (anchor === undefined || anchor.identity !== identity) anchor = await anchorIn(scope);
    if (anchor === undefined) {
      const refused = { scope, handle: undefined, live: true };
      try {
        return await binding.run(refused, operation);
      } finally {
        refused.live = false;
      }
    }
    anchor.users += 1;
    keep(anchors, anchor, removeAnchor);
    const anchored = { scope: anchor, handle: anchor, live: true };
    try {
      return await binding.run(anchored, operation);
    } finally {
      anchored.live = false;
      await release(anchors, anchor, removeAnchor);
    }
  }
  handle.users += 1;
  keep(handles, handle, close);
  const run = { scope: handle, handle, live: true };
  try {
    return await binding.run(run, operation);
  } finally {
    run.live = false;
    release(handles, handle, close);
  }
}

// The cache-changing or cache-unbindable failure behind a write failure that wraps it, so a caller sees that the cache
// directory moved, or that no change of it could be bound.
export function cacheBindingFailureIn(error: unknown): IndexingError | undefined {
  let cause: unknown = error;
  for (let depth = 0; depth < 8 && cause !== null && cause !== undefined; depth += 1) {
    if (cause instanceof IndexingError && (cause.diagnostic.code === "cache-changing" || cause.diagnostic.code === "cache-unbindable")) return cause;
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

// Once Node's rm has found its target, it takes whatever it then finds missing as removed, so a retarget after that
// reports success with the target still there, and it reaches what a directory holds by a path a link swapped in for
// that directory sends elsewhere. The helper of the anchor removes the tree moved into it under the given name instead,
// by calls that report a missing path, each relative to a directory it has entered and found to be the one it examined.
// The tree is known to be there, so whatever of it is found missing was looked for elsewhere. An error names the target
// and what it held, not where they were moved.
async function removeTree(anchor: Anchor, staged: string, target: string): Promise<void> {
  const answer = await ask(anchor, staged);
  if (answer === undefined) throw new IndexingError({ phase: "cache", path: anchor.dir, code: "cache-write-failed" }, new Error("the anchor helper exited before it answered"));
  const reported = JSON.parse(answer) as {
    readonly elsewhere?: boolean | undefined;
    readonly code?: string | undefined;
    readonly errno?: number | undefined;
    readonly syscall?: string | undefined;
    readonly path?: string | undefined;
    readonly message?: string | undefined;
    readonly at?: readonly string[] | undefined;
  };
  if (reported.message === undefined || reported.at === undefined) {
    if (reported.elsewhere === true) throw changingIn(anchor);
    return;
  }
  if (reported.code === "ENOENT") throw changingIn(anchor);
  // The helper names what it was removing, at, relative to the directory it had entered.
  const named = path.join(target, ...reported.at.slice(1));
  const message = reported.path === undefined ? reported.message : reported.message.split(`'${reported.path}'`).join(`'${named}'`);
  throw Object.assign(new Error(message), { code: reported.code, errno: reported.errno, syscall: reported.syscall, path: named });
}

// Node's recursive rm reaches what a directory holds by path.join, which drops the anchor, so the target is first moved
// into the anchor and removed there. A missing target is only taken as missing once the cache directory lacks it.
async function remove(anchor: Anchor, call: Call, target: string, options: unknown): Promise<void> {
  const given = (typeof options === "object" && options !== null ? options : {}) as { readonly force?: boolean | undefined; readonly recursive?: boolean | undefined };
  // Settles a failure of a step that finds the target missing: done when forced, and anything else is thrown.
  const missing = async (error: unknown, reported: () => Promise<unknown>): Promise<void> => {
    if (codeOf(error) !== "ENOENT") throw unbound(anchor, error);
    if (!(await absentIn(anchor, target))) throw changingIn(anchor);
    if (given.force !== true) throw await reported();
  };
  if (given.recursive !== true) {
    const at = bound(anchor, target) as string;
    const found = await promises.lstat(at).catch(async (error: unknown) => {
      await missing(error, async () => unbound(anchor, error));
      return undefined;
    });
    if (found === undefined) return;
    if (!found.isDirectory()) {
      await promises.unlink(at).catch(async (error: unknown) => await missing(error, async () => unbound(anchor, error)));
      return;
    }
    // rm refuses a directory without recursive before it removes anything, with the error it gives outside a run, so
    // what it does remove was no longer the directory found there.
    await call(at, { ...given, force: false }).then(() => {
      throw changingIn(anchor);
    }, async (error: unknown) => await missing(error, async () => unbound(anchor, error)));
    return;
  }
  const staged = randomUUID();
  const trash = `${anchor.anchor}${path.sep}${staged}`;
  // rm itself reports a missing target with the error lstat gives.
  const reported = async (): Promise<unknown> => await promises.lstat(bound(anchor, target) as string).then(() => changingIn(anchor), (error: unknown) => unbound(anchor, error));
  const moved = await promises.rename(bound(anchor, target) as string, trash).then(() => true, async (error: unknown) => {
    await missing(error, reported);
    return false;
  });
  if (moved) await removeTree(anchor, staged, target);
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
    if (handle === undefined) throw new IndexingError({ phase: "cache", path: run.scope.dir, code: "cache-unbindable" });
    await ensureSame(run.scope);
    const settled = await changeThrough(handle, name, call, args, paths).then((value) => ({ value }), (error: unknown) => ({ error }));
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
