import { AsyncLocalStorage } from "node:async_hooks";
import childProcess, { type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, promises } from "node:fs";
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
// directory, made by a helper process whose working directory is the cache directory, relative to it. The working
// directory binds the cache directory as a descriptor does, so the helper makes every change within it, by a path
// relative to it, and this process makes none. A path through the anchor can be sent elsewhere by renaming the anchor
// or a parent, so the helper first checks that <cache>/<anchor>/.. still names the cache directory, and refuses the
// change with cache-changing when it does not, as when the cache path is retargeted or the anchor removed. Every change
// is also checked before and after against the cache directory's identity, which stops a run once a retarget stays in
// place. A rename binds only one directory, so a recursive rm cannot move its target aside; the helper removes it in
// place, directory by directory, entering each one and finding it to be the one an lstat just found there, so a
// directory swapped for a link sends no removal outside the tree. Reads within the cache directory go through
// <cache>/<anchor>/.., which the kernel resolves through the anchor's own parent. A run that finds the cache directory
// moved, or the anchor gone, drops the anchor, so the next run makes a new one. The helper removes the anchor too, by
// its name, once displaced, or as its input closes when this process exits or dies. An anchor is left behind when it
// is removed after the cache directory moved, when it holds anything as it is removed, or when the process ends while
// the anchor has no helper. Where .. drops the name before it instead, as Windows resolves it, no anchor can bind the
// directory. Windows refuses to rename or remove a directory while a file inside it is open, so there each run first
// opens the directory the cache path names, creating nothing, and fails with cache-changing unless it has the cache
// directory's identity; while that handle is open, it creates a pin, a file under a random name in the cache directory
// that no other open may share and that is removed as it closes. The pin's real path names, through real directories
// only, the directory that holds it, which stays where it is with every directory above it while the pin is open; once
// its identity is the cache directory's, every cacheFs call within the cache directory goes by that path. A pin that
// lands elsewhere fails the run with cache-changing before it changes anything. On another platform that resolves ..
// by name, and in a worker thread elsewhere, which makes no anchor, nothing binds the directory, so every change within
// it fails with cache-unbindable before it changes anything; reads go by path.
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

// What a helper answers to a change: what it returned, or the error it failed with, or that the anchor no longer led
// back to the cache directory, and with lost, that the helper is no longer in the cache directory and exits.
interface Answer {
  readonly value?: unknown;
  readonly elsewhere?: boolean | undefined;
  readonly lost?: boolean | undefined;
  readonly code?: string | undefined;
  readonly errno?: number | undefined;
  readonly syscall?: string | undefined;
  readonly path?: string | undefined;
  readonly dest?: string | undefined;
  readonly message?: string | undefined;
  readonly at?: readonly string[] | undefined;
}

interface Anchor extends Kept {
  readonly anchor: string;
  helper: Promise<Helper> | undefined;
}

interface Pin extends Bound {
  readonly file: FileHandle;
  readonly pin: string;
}

// live ends with the operation, so a call that outlives it, from work the operation started without awaiting, uses the
// path as given rather than a descriptor that may since have closed and been reused, or an anchor or pin since removed.
// A run without any of them refuses every change within the cache directory.
const binding = new AsyncLocalStorage<{ readonly scope: Scope; readonly handle: Handle | Anchor | Pin | undefined; live: boolean }>();
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
const anchors = shared[anchorRegistry] ??= new Map<string, Anchor>();
const keptHandles = 4;
let unsupported = process.platform !== "linux";
// Whether .. resolves through the directory before it, probed by the first run that needs an anchor.
let physicalParent: boolean | undefined;
// On Windows a pin opens with libuv's flags for no sharing and for removal as it closes, which Node passes through as
// given and no other platform's open takes; elsewhere the pin is unlinked after it closes.
const removedOnClose = process.platform === "win32";
const pinFlags = constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (removedOnClose ? 0x10000000 | 0x40 : 0);

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

// The exit code of a helper that found its working directory not to be the cache directory, or the anchor missing.
const elsewhereExit = 3;
// Started in the cache directory, makes the anchor there, or finds it, by its name alone, once "." has the cache
// directory's identity, and writes an empty line. Each line it then reads is a change, in JSON, followed by size bytes
// of data, and it answers each with a line of JSON. A change is made only while the anchor's path, via, leads back to
// the cache directory. A recursive rm enters each directory it removes, and each directory on the way to it, and finds
// it to be the one an lstat just found there, so a directory replaced, or swapped for a link, before it is entered stops
// the removal before it changes anything there; what is removed is named relative to the directory entered, so no link
// is followed. at names what it was removing, relative to the cache directory. Before each change the helper checks
// that "." still has the cache directory's identity. A helper that finds it has not, or whose entry into a directory
// fails its check, or that cannot find its way back into the cache directory, answers and exits, so no change queued
// behind is made from wherever it is.
const serveAnchor = [
  `const fs = require("node:fs");`,
  `const path = require("node:path");`,
  `const [name, mode, identity, via] = process.argv.slice(1);`,
  `const identityOf = (stat) => \`\${stat.dev}:\${stat.ino}\`;`,
  `const here = () => identityOf(fs.statSync(".", { bigint: true }));`,
  `const elsewhere = new Error("elsewhere");`,
  `const enter = (dir, expected) => {`,
  `  try { process.chdir(dir); } catch { throw elsewhere; }`,
  `  if (here() !== expected) throw elsewhere;`,
  `};`,
  `if (here() !== identity) process.exit(${elsewhereExit});`,
  `if (mode === "make") fs.mkdirSync(name);`,
  `try {`,
  `  if (!fs.lstatSync(name).isDirectory()) throw elsewhere;`,
  `} catch {`,
  `  process.exit(${elsewhereExit});`,
  `}`,
  `const entered = [identity];`,
  `const at = [];`,
  `let dropped = false;`,
  `const missing = (error) => error !== elsewhere && error.code === "ENOENT";`,
  `const remove = (entry) => {`,
  `  at.push(entry);`,
  `  let found;`,
  `  try {`,
  `    found = fs.lstatSync(entry, { bigint: true });`,
  `  } catch (error) {`,
  `    if (!missing(error)) throw error;`,
  `    at.pop();`,
  `    return;`,
  `  }`,
  `  if (found.isDirectory()) {`,
  `    enter(entry, identityOf(found));`,
  `    entered.push(identityOf(found));`,
  `    for (const inner of fs.readdirSync(".")) remove(inner);`,
  `    entered.pop();`,
  `    enter("..", entered.at(-1));`,
  `  }`,
  `  try {`,
  `    if (found.isDirectory()) fs.rmdirSync(entry);`,
  `    else fs.unlinkSync(entry);`,
  `  } catch (error) {`,
  `    if (!missing(error)) throw error;`,
  `  }`,
  `  at.pop();`,
  `};`,
  `const removeTree = (target, force) => {`,
  `  try {`,
  `    fs.lstatSync(target);`,
  `  } catch (error) {`,
  `    if (missing(error) && force) return;`,
  `    throw error;`,
  `  }`,
  `  const names = target.split(path.sep);`,
  `  const last = names.pop();`,
  `  for (const part of names) {`,
  `    at.push(part);`,
  `    const found = fs.lstatSync(part, { bigint: true });`,
  `    if (!found.isDirectory()) throw elsewhere;`,
  `    enter(part, identityOf(found));`,
  `    entered.push(identityOf(found));`,
  `  }`,
  `  remove(last);`,
  `};`,
  `const changes = {`,
  `  copyFile: ([from, to, mode]) => fs.copyFileSync(from, to, mode),`,
  `  mkdir: ([dir, options]) => fs.mkdirSync(dir, options),`,
  `  rename: ([from, to]) => fs.renameSync(from, to),`,
  `  rm: ([target, options]) => options?.recursive === true ? removeTree(target, options.force === true) : fs.rmSync(target, options),`,
  `  rmdir: ([dir, options]) => fs.rmdirSync(dir, options),`,
  `  unlink: ([file]) => fs.unlinkSync(file),`,
  `  writeFile: ([file, options], data) => fs.writeFileSync(file, data, options),`,
  `  drop: () => fs.rmdirSync(name),`,
  `};`,
  `const bound = () => {`,
  `  try {`,
  `    return identityOf(fs.statSync(via, { bigint: true })) === identity;`,
  `  } catch {`,
  `    return false;`,
  `  }`,
  `};`,
  `const home = () => {`,
  `  try {`,
  `    return here() === identity;`,
  `  } catch {`,
  `    return false;`,
  `  }`,
  `};`,
  `const answer = (change, data) => {`,
  `  if (change.name === "drop") dropped = true;`,
  `  if (!home()) return { elsewhere: true, lost: true };`,
  `  if (!bound()) return { elsewhere: true };`,
  `  at.length = 0;`,
  `  let reply;`,
  `  try {`,
  `    reply = { value: changes[change.name](change.args.map((arg) => arg ?? undefined), data) };`,
  `  } catch (error) {`,
  `    if (error === elsewhere) return { elsewhere: true, lost: true };`,
  `    reply = { code: error.code, errno: error.errno, syscall: error.syscall, path: error.path, dest: error.dest, message: error.message, at: [...at] };`,
  `  }`,
  `  if (entered.length === 1) return reply;`,
  `  try {`,
  `    while (entered.length > 1) {`,
  `      entered.pop();`,
  `      enter("..", entered.at(-1));`,
  `    }`,
  `  } catch {`,
  `    reply = { elsewhere: true, lost: true };`,
  `  }`,
  `  return reply;`,
  `};`,
  `let header = [];`,
  `let change;`,
  `let data;`,
  `let filled = 0;`,
  `const take = (chunk) => {`,
  `  for (;;) {`,
  `    if (change === undefined) {`,
  `      const end = chunk.indexOf(10);`,
  `      if (end < 0) {`,
  `        if (chunk.length > 0) header.push(chunk);`,
  `        return;`,
  `      }`,
  `      change = JSON.parse(Buffer.concat([...header, chunk.subarray(0, end)]).toString("utf8"));`,
  `      header = [];`,
  `      chunk = chunk.subarray(end + 1);`,
  `      data = Buffer.allocUnsafe(change.size);`,
  `      filled = 0;`,
  `    }`,
  `    const copied = chunk.copy(data, filled);`,
  `    filled += copied;`,
  `    chunk = chunk.subarray(copied);`,
  `    if (filled < data.length) return;`,
  `    const reply = answer(change, data);`,
  `    change = undefined;`,
  `    if (reply.lost !== true) {`,
  `      process.stdout.write(JSON.stringify(reply) + "\\n");`,
  `      continue;`,
  `    }`,
  `    process.stdin.pause();`,
  `    process.stdout.write(JSON.stringify(reply) + "\\n", () => process.exit(${elsewhereExit}));`,
  `    return;`,
  `  }`,
  `};`,
  `process.stdin.on("data", take);`,
  `process.stdin.on("end", () => {`,
  `  try {`,
  `    if (!dropped && home() && bound()) fs.rmdirSync(name);`,
  `  } catch {`,
  `    // the anchor stays behind`,
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
    const child = childProcess.spawn(process.execPath, ["-e", serveAnchor, path.basename(anchor.anchor), mode, anchor.identity, anchor.via], { cwd: anchor.dir, env: helperEnv(), stdio: "pipe", windowsHide: true });
    const helper: Helper = { child, answers: [], closed: false };
    let ready = false;
    let buffered = "";
    let stderr = "";
    const settle = (cause: () => unknown, left?: string): void => {
      helper.closed = true;
      if (anchor.helper === started) anchor.helper = undefined;
      for (const answer of helper.answers.splice(0)) answer(left);
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
      : new IndexingError({ phase: "cache", path: anchor.dir, code: "cache-write-failed" }, new Error(`the anchor helper exited with ${code ?? signal}: ${stderr}`)),
    code === elsewhereExit ? JSON.stringify({ elsewhere: true }) : undefined));
  });
  anchor.helper = started;
  return started;
}

// What the helper of anchor answers to change, or undefined when it exits first. The change is a line of JSON, which
// names the size of the data that follows it.
async function ask(anchor: Anchor, change: { readonly name: Bindable | "drop"; readonly args: readonly unknown[] }, data: Buffer = Buffer.alloc(0)): Promise<Answer | undefined> {
  const serving = anchor.helper ?? serve(anchor, "enter");
  const helper = await serving;
  if (helper.closed) return undefined;
  const line = await new Promise<string | undefined>((resolve) => {
    helper.answers.push(resolve);
    waiting(helper);
    helper.child.stdin.write(`${JSON.stringify({ ...change, size: data.length })}\n`);
    if (data.length > 0) helper.child.stdin.write(data);
  });
  if (line === undefined) return undefined;
  const answer = JSON.parse(line) as Answer;
  // A change sent after this one would reach the helper as it exits, so the next starts another.
  if (answer.lost === true) {
    helper.closed = true;
    if (anchor.helper === serving) anchor.helper = undefined;
  }
  return answer;
}

// Besides a descriptor, the working directory is the one reference to a directory that the kernel resolves a relative
// path from without resolving that directory's ancestors again. This process could only enter its own working directory
// again by the path it had, which a retarget or removal can leave naming another directory or none, so a helper process
// started in the cache directory makes the anchor, and every change after it, there. The anchor lands in the cache
// directory or nowhere, and this process's working directory never changes. A worker thread makes no anchor: one
// terminated runs no exit handler, so its anchors would stay behind.
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

// The anchor's path resolves the cache directory's ancestors again, so a parent retargeted would send its removal
// elsewhere. The helper removes the anchor instead, by its name in the directory it is in, once it has found that
// directory to be the cache directory and the anchor's path to lead back to it; an anchor that holds anything stays
// behind. The helper does the same as its input closes, as it does when this process exits or dies, and then exits.
async function removeAnchor(anchor: Anchor): Promise<void> {
  await ask(anchor, { name: "drop", args: [] }).catch(() => {});
  void anchor.helper?.then((helper) => helper.child.stdin.end(), () => {});
}

// Opens a pin in the cache directory, as described above. The pin is created only once a handle open on the directory
// the cache path names has the cache directory's identity: a retarget made before that open fails the run with nothing
// created, and the open handle keeps every directory above the cache directory in place until the pin is open. The
// real path of the pin is found by a call that opens it for no access, which its sharing does not refuse, and its
// directory must have the cache directory's identity while that path still names the pin.
async function pinIn(scope: Scope): Promise<Pin> {
  let held: FileHandle;
  try {
    held = await promises.open(scope.dir, constants.O_RDONLY);
  } catch (error) {
    throw new IndexingError({ phase: "cache", path: scope.dir, code: "cache-changing" }, error);
  }
  try {
    if (identityOf(await held.stat({ bigint: true })) !== scope.identity) throw changingIn(scope);
    return await pinWithin(scope);
  } finally {
    await held.close().catch(() => {});
  }
}

async function pinWithin(scope: Scope): Promise<Pin> {
  const placed = `${scope.prefix}.osnova-bound-${randomUUID()}`;
  let file: FileHandle;
  try {
    file = await promises.open(placed, pinFlags);
  } catch (error) {
    throw new IndexingError({ phase: "cache", path: scope.dir, code: "cache-write-failed" }, error);
  }
  let pin = placed;
  try {
    pin = await promises.realpath(placed);
    const via = path.dirname(pin);
    const [own, found, dir] = await Promise.all([file.stat({ bigint: true }), promises.lstat(pin, { bigint: true }), promises.stat(via, { bigint: true })]);
    if (identityOf(found) !== identityOf(own) || identityOf(dir) !== scope.identity) throw changingIn(scope);
    return { ...scope, via, file, pin };
  } catch (error) {
    await unpin({ file, pin });
    if (error instanceof IndexingError) throw error;
    throw new IndexingError({ phase: "cache", path: scope.dir, code: "cache-changing" }, error);
  }
}

async function unpin(pin: { readonly file: FileHandle; readonly pin: string }): Promise<void> {
  await pin.file.close().catch(() => {});
  if (!removedOnClose) await promises.unlink(pin.pin).catch(() => {});
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
// descriptor can bind the directory, a pin or an anchor binds it, or each change within it is refused, as described
// above.
export async function withBoundCacheDir<T>(canonicalCache: string, identity: string, operation: () => Promise<T>): Promise<T> {
  let handle = unsupported ? undefined : handles.get(canonicalCache);
  if (!unsupported && (handle === undefined || handle.identity !== identity)) handle = await open(canonicalCache, identity);
  if (handle === undefined) {
    const scope = { dir: canonicalCache, prefix: prefixOf(canonicalCache), identity };
    if (process.platform === "win32") {
      const pin = await pinIn(scope);
      const pinned = { scope: pin, handle: pin, live: true };
      try {
        return await binding.run(pinned, operation);
      } finally {
        pinned.live = false;
        await unpin(pin);
      }
    }
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

// A path as the helper takes it: relative to the cache directory, its working directory, when it lies within it, and
// absolute otherwise.
function relativeIn(anchor: Anchor, target: unknown): string {
  if (typeof target !== "string") throw new IndexingError({ phase: "cache", path: anchor.dir, code: "cache-unbindable" });
  const absolute = path.resolve(target);
  if (absolute === anchor.dir) return ".";
  return absolute.startsWith(anchor.prefix) ? absolute.slice(anchor.prefix.length) : absolute;
}

function absoluteIn(anchor: Anchor, target: string): string {
  if (path.isAbsolute(target)) return target;
  return target === "." ? anchor.dir : `${anchor.prefix}${target}`;
}

// The bytes writeFile writes, a string encoded as its options say; data of any other kind cannot be sent to the helper.
function bytesOf(anchor: Anchor, data: unknown, options: unknown): Buffer {
  const encoding = typeof options === "string" ? options : (options as { readonly encoding?: unknown } | null | undefined)?.encoding;
  if (typeof data === "string") return Buffer.from(data, typeof encoding === "string" && Buffer.isEncoding(encoding) ? encoding : "utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new IndexingError({ phase: "cache", path: anchor.dir, code: "cache-unbindable" });
}

// The error a change failed with, naming what the call was given: at, for a recursive rm, names what it was removing
// within the cache directory. A SystemError ends its message with the path, unquoted.
function failureOf(anchor: Anchor, answer: Answer & { readonly message: string }): Error {
  const named = answer.at !== undefined && answer.at.length > 0 ? path.join(anchor.dir, ...answer.at)
    : answer.path === undefined ? undefined : absoluteIn(anchor, answer.path);
  const dest = answer.dest === undefined ? undefined : absoluteIn(anchor, answer.dest);
  let message = answer.message;
  for (const [given, shown] of [[answer.path, named], [answer.dest, dest]] as const) {
    if (given !== undefined && shown !== undefined) message = message.split(`'${given}'`).join(`'${shown}'`);
  }
  if (answer.path !== undefined && named !== undefined && message.endsWith(` ${answer.path}`)) message = `${message.slice(0, -answer.path.length)}${named}`;
  const fields = { code: answer.code, errno: answer.errno, syscall: answer.syscall, path: named, dest };
  return Object.assign(new Error(message), Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)));
}

// The helper of anchor makes the change by paths relative to the cache directory, and this gives the result and error
// the call gives outside a run.
async function changeThrough(anchor: Anchor, name: Bindable, args: readonly unknown[], paths: number): Promise<unknown> {
  const sent = args.map((arg, index) => index < paths ? relativeIn(anchor, arg) : arg);
  let data: Buffer | undefined;
  if (name === "writeFile") {
    data = bytesOf(anchor, args[1], args[2]);
    sent.splice(1, 1);
  }
  const answer = await ask(anchor, { name, args: sent }, data);
  if (answer === undefined) throw new IndexingError({ phase: "cache", path: anchor.dir, code: "cache-write-failed" }, new Error("the anchor helper exited before it answered"));
  if (answer.elsewhere === true) throw changingIn(anchor);
  if (answer.message !== undefined) throw failureOf(anchor, { ...answer, message: answer.message });
  return name === "mkdir" && typeof answer.value === "string" ? absoluteIn(anchor, answer.value) : answer.value;
}

// The method is looked up on each call, so whatever replaces it on the promises API sees the call, except a change
// within a cache directory an anchor binds, which the anchor's helper makes.
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
    const settled = await changeThrough(handle, name, args, paths).then((value) => ({ value }), (error: unknown) => ({ error }));
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
