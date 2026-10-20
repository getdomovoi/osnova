import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import { loadArtifact, saveArtifact, serializeArtifact, extractionVersion, artifactPathFor, artifactTextPathFor, artifactEdgesPathFor, isSectionInconsistency } from "./index/serialize.js";
import { resolveCacheDir, workspaceDirFor, canonicalWorkspaceLockPath, workspaceKey, cacheLimits, evictLru } from "./cache/cache.js";
import type { LoadIndexOptions, OsnovaIndex } from "./types.js";
import { canonicalWorkspaceRoot, canonicalWorkspaceRootSync, workspaceIdentity, validRelativePath } from "./index/workspace.js";
import type { WorkspaceOptions } from "./index/workspace.js";
import { cacheLockTimeoutIn, foreignLockHolds, foreignLockHoldsSync, withCacheLock } from "./cache/lock.js";
import { buildIndexSnapshot } from "./index/build.js";
import { applyFreshnessReport, inspectFreshness, isStale } from "./index/incremental.js";
import { loadVerification, saveVerification } from "./index/verification.js";
import { scanWorkspace, sameFileMetadata } from "./index/scan.js";
import type { ScanWitness } from "./index/scan.js";
import { IndexingError } from "./index/diagnostics.js";
import { knownIndexGeneration, rememberIndexGeneration } from "./index/generation.js";
import { ensureFamilySidecar, seedProgress, seedWorkspace } from "./index/seed.js";
import { cacheBindingFailureIn, cacheFs, ensureCacheDir, withBoundCacheDir } from "./cache/bound.js";

export type { WorkspaceOptions } from "./index/workspace.js";
export type { CachePolicy } from "./cache/cache.js";
export type { LockOptions } from "./cache/lock.js";

export interface EvidenceFingerprint {
  readonly workspace: string;
  readonly generation: string;
  readonly extractionVersion: string;
  readonly sourceHashes: Readonly<Record<string, string>>;
}

export function indexGeneration(index: OsnovaIndex): string {
  return knownIndexGeneration(index) ?? rememberIndexGeneration(index, serializeArtifact(index));
}

export function evidenceFingerprint(index: OsnovaIndex, paths: Iterable<string> = index.files.keys()): EvidenceFingerprint {
  const sourceHashes: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const file of [...new Set(paths)].sort()) {
    if (!validRelativePath(file) || !index.files.has(file)) throw new Error(`osnova: file not indexed: ${JSON.stringify(file)}`);
    sourceHashes[file] = index.files.get(file)!.hash;
  }
  return { workspace: workspaceKey(index.root), generation: indexGeneration(index), extractionVersion, sourceHashes };
}

const refreshing = new Map<string, Promise<WitnessedIndex>>();
const loadedIndexes = new Map<string, { index: OsnovaIndex; artifact: string }>();

async function artifactSignature(canonicalRoot: string, cacheDir: string): Promise<string | undefined> {
  const artifact = await artifactPathFor(canonicalRoot, cacheDir, true);
  const edges = await artifactEdgesPathFor(canonicalRoot, cacheDir, true);
  const text = await artifactTextPathFor(canonicalRoot, cacheDir, true);
  if (artifact === undefined || edges === undefined || text === undefined) return undefined;
  const parts: string[] = [];
  for (const file of [artifact, edges, text]) {
    const stat = await cacheFs.stat(file, { bigint: true });
    parts.push([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":"));
  }
  return parts.join("|");
}

function rememberLoaded(key: string, index: OsnovaIndex, artifact: string | undefined, limit: number): void {
  loadedIndexes.delete(key);
  if (artifact === undefined || limit === 0) return;
  loadedIndexes.set(key, { index, artifact });
  while (loadedIndexes.size > limit) loadedIndexes.delete(loadedIndexes.keys().next().value as string);
}

// A cached artifact is derived data. When it cannot be decoded, rebuilding it is the repair, the
// same as for an inconsistent sidecar. A failure of the file system itself (a system error such as
// EACCES or EIO) or of a lock is not repaired by rebuilding and is reported instead.
export function isRebuildableCacheFailure(error: unknown): boolean {
  if (isSectionInconsistency(error)) return true;
  let readFailure = false;
  let cause: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (cause instanceof IndexingError && cause.diagnostic.code === "cache-read-failed") readFailure = true;
    const next = (cause as { cause?: unknown } | null | undefined)?.cause;
    if (next === undefined || next === null) break;
    cause = next;
  }
  if (!readFailure || cause instanceof IndexingError) return false;
  return cause instanceof Error && typeof (cause as NodeJS.ErrnoException).syscall !== "string";
}

async function readGeneration(canonicalRoot: string, cacheDir: string): Promise<string | undefined> {
  const file = path.join(workspaceDirFor(cacheDir, canonicalRoot, true), "index.sha");
  try {
    return (await cacheFs.readFile(file, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// The device and inode of the directory a canonical root names now, or undefined when the path resolves to another
// path. An ordinary directory renamed into a parent's place leaves every path the same, so only these tell it apart.
async function rootIdentity(canonicalRoot: string): Promise<string | undefined> {
  let resolved: string;
  let identity: string;
  try {
    resolved = await fs.realpath(canonicalRoot);
    const stat = await fs.stat(canonicalRoot, { bigint: true });
    if (!stat.isDirectory()) throw new Error("workspace root is not a directory");
    identity = `${stat.dev}:${stat.ino}`;
  } catch (error) {
    throw new IndexingError({ phase: "scan", path: canonicalRoot, code: "directory-unreadable" }, error);
  }
  return resolved === canonicalRoot ? identity : undefined;
}

export async function refreshWorkspace(root: string, options: WorkspaceOptions = {}): Promise<OsnovaIndex> {
  return (await refreshWorkspaceWitnessed(root, { ...options, rebuild: false })).index;
}

// The index together with the witness of the scan it was verified against. The witness is taken before verification,
// so while it still holds, the working tree is the one the index was verified against.
export interface WitnessedIndex {
  readonly index: OsnovaIndex;
  readonly witness: ScanWitness;
}

// rebuild ignores the cached artifact and the kept index and builds from the working tree, for a caller whose
// index failed to read a cache section that loading does not fully verify, such as the source text. canonical says root
// is a canonical root the caller resolved, so the refresh locks that root or fails, never another one the path names.
export interface WitnessedRefreshOptions extends WorkspaceOptions {
  readonly rebuild?: boolean | undefined;
  readonly canonical?: boolean | undefined;
}

export async function refreshWorkspaceWitnessed(root: string, options: WitnessedRefreshOptions = {}): Promise<WitnessedIndex> {
  const canonicalRoot = await canonicalWorkspaceRoot(root);
  if (options.canonical === true && canonicalRoot !== root) throw new IndexingError({ phase: "scan", path: root, code: "workspace-changing" });
  const limits = cacheLimits(options);
  const cacheDir = resolveCacheDir(options.cacheDir);
  const cacheIdentity = await ensureCacheDir(cacheDir);
  const canonicalCache = await fs.realpath(cacheDir);
  const indexKey = JSON.stringify([canonicalCache, canonicalRoot]);
  const rebuild = options.rebuild === true;
  const taskKey = JSON.stringify([indexKey, limits, options.lockTimeoutMs, options.lockPollMs, options.reuseMemory, rebuild]);
  const running = refreshing.get(taskKey);
  if (running !== undefined) return running;
  // The coalescing key and the lock both name the root resolved above, never what the path resolves to later, and the
  // directory it named once the lock was held is known by its device and inode. A root retargeted since then, or by the
  // time the scan resolves and stats it again, is not the root this lock covers, so the refresh fails instead. Loading
  // names the locked root's lock and entry without resolving the path again. Building and inspection read sources
  // through the path, so an index of another root, or one read through a retargeted path, fails the refresh before its
  // files are inspected, before anything is written, before each later write and before it returns. An index the scan
  // verified unchanged reads no source after the scan and skips those rechecks. Every cache path inside the lock names
  // the locked root's entry without resolving the path again, and where the platform allows, every cache operation
  // reaches the cache directory the lock was taken in without resolving its ancestors again, so a retarget undone
  // between two checks cannot redirect a write; one undone while sources are read is not seen. Where no descriptor can
  // bind the cache directory, an anchor directory inside it does, and a call a retarget redirects changes nothing and
  // fails the refresh with cache-changing. On Windows a file held open in the cache directory keeps it and every
  // directory above it in place. Where another platform resolves .. by name, or in a worker thread there, nothing can
  // bind a cache write, so the first one fails the refresh with cache-unbindable before it changes anything (see
  // withBoundCacheDir).
  const task = withBoundCacheDir(canonicalCache, cacheIdentity, () => withCacheLock(canonicalWorkspaceLockPath(canonicalCache, canonicalRoot), async () => {
    const changing = (): IndexingError => new IndexingError({ phase: "scan", path: canonicalRoot, code: "workspace-changing" });
    const identity = await rootIdentity(canonicalRoot);
    if (identity === undefined) throw changing();
    const rootMoved = async (): Promise<boolean> => await rootIdentity(canonicalRoot) !== identity;
    const published = await artifactSignature(canonicalRoot, canonicalCache);
    const cached = loadedIndexes.get(indexKey);
    const generation = await readGeneration(canonicalRoot, canonicalCache);
    const verified = generation === undefined ? undefined : (await loadVerification(canonicalCache, canonicalRoot, generation, true))?.files;
    const { scan, witness } = await scanWorkspace(canonicalRoot, canonicalCache);
    const scanned = witness.directories.get("");
    if (witness.root !== canonicalRoot || scanned === undefined || `${scanned.dev}:${scanned.ino}` !== identity) throw changing();
    const clean = verified !== undefined && scan.paths.length === verified.size &&
      scan.paths.every((p) => sameFileMetadata(verified.get(p), scan.metadata.get(p)));
    let index: OsnovaIndex | undefined;
    if (rebuild) {
      index = undefined;
    } else if (options.reuseMemory === true && cached !== undefined && cached.artifact === published &&
      generation !== undefined && /^[a-f0-9]{64}$/.test(generation) && indexGeneration(cached.index) === generation) {
      index = cached.index;
    } else if (clean || generation !== undefined) {
      try {
        index = await loadArtifact(canonicalRoot, canonicalCache, true);
      } catch (error) {
        if (!isRebuildableCacheFailure(error)) throw error;
        index = undefined;
      }
    }
    const seed = index === undefined && generation === undefined && !rebuild
      ? await seedWorkspace(canonicalRoot, canonicalCache, options, true)
      : undefined;
    let seededFrom = seed?.sibling;
    index ??= seed?.index;
    let dirty = index === undefined || seededFrom !== undefined;
    let known = index === undefined || seededFrom !== undefined || indexGeneration(index) !== generation ? undefined : verified;
    let rebuiltAfterSectionFailure = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        index ??= await buildIndexSnapshot(canonicalRoot, options.onProgress, canonicalCache);
        const unchanged = clean && known !== undefined && attempt === 0 && !dirty;
        const ensureRoot = async (): Promise<void> => {
          if (!unchanged && await rootMoved()) throw changing();
        };
        if (index.root !== canonicalRoot) throw changing();
        await ensureRoot();
        const inspection = unchanged
          ? { report: { added: [], changed: [], deleted: [] }, metadata: scan.metadata, hashedFiles: 0 }
          : await inspectFreshness(index, canonicalRoot, known, attempt === 0 ? scan : undefined);
        const report = inspection.report;
        if (seededFrom !== undefined) {
          options.onProgress?.(seedProgress(seededFrom, index.files.size, report));
          seededFrom = undefined;
        }
        if (!isStale(report)) {
          await ensureRoot();
          if (dirty) await saveArtifact(index, canonicalCache, options, true);
          else {
            const artifact = await artifactPathFor(canonicalRoot, canonicalCache, true);
            if (limits.maxWorkspaces === 0 || artifact === undefined || (await cacheFs.stat(artifact)).size > limits.maxBytes) {
              throw new IndexingError({ phase: "cache", path: canonicalCache, code: "cache-limit-exceeded" });
            }
            await evictLru(canonicalCache, options);
          }
          if (!unchanged) {
            await ensureRoot();
            try {
              await saveVerification(canonicalCache, canonicalRoot, indexGeneration(index), inspection.metadata, true);
            } catch (error) {
              throw new IndexingError({ phase: "cache", path: canonicalCache, code: "verification-write-failed" }, error);
            }
          }
          await ensureRoot();
          await ensureFamilySidecar(canonicalCache, canonicalRoot, seed?.family, seed !== undefined, true);
          if (options.reuseMemory === true) {
            rememberLoaded(indexKey, index, await artifactSignature(canonicalRoot, canonicalCache), limits.maxWorkspaces);
          }
          await ensureRoot();
          return { index, witness };
        }
        index = await applyFreshnessReport(index, canonicalRoot, [...report.added, ...report.changed, ...report.deleted], report);
        known = inspection.metadata;
        dirty = true;
      } catch (error) {
        if (rebuiltAfterSectionFailure || !isRebuildableCacheFailure(error)) throw error;
        rebuiltAfterSectionFailure = true;
        index = undefined;
        known = undefined;
        dirty = true;
      }
    }
    throw changing();
  }, options)).catch((error: unknown) => {
    // The lock a refresh actually waited on is often a nested one, such as the cache-wide eviction
    // lock, wrapped in a read or write failure that names only the workspace directory. A cache directory that moved
    // under a write, or one no write could be bound to, is reported as such, not as the write that found it.
    throw cacheLockTimeoutIn(error) ?? cacheBindingFailureIn(error) ?? error;
  });
  refreshing.set(taskKey, task);
  try {
    return await task;
  } finally {
    if (refreshing.get(taskKey) === task) refreshing.delete(taskKey);
  }
}

// Whether another owner may hold the lock a refresh of this workspace would take. It takes no lock and creates
// nothing, so a caller may ask before every reuse of a kept index; a cache directory that does not exist holds no lock.
// A root or cache directory that cannot be resolved names no lock path to check, so it counts as contended.
export async function workspaceLockContended(root: string, cacheDir?: string | undefined): Promise<boolean> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await canonicalWorkspaceRoot(root);
  } catch {
    return true;
  }
  let canonicalCache: string;
  try {
    canonicalCache = await fs.realpath(resolveCacheDir(cacheDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }
  return foreignLockHolds(canonicalWorkspaceLockPath(canonicalCache, canonicalRoot));
}

// workspaceLockContended without yielding, so a caller can act on the answer before anything else runs.
export function workspaceLockContendedSync(root: string, cacheDir?: string | undefined): boolean {
  let canonicalRoot: string;
  try {
    canonicalRoot = canonicalWorkspaceRootSync(root);
  } catch {
    return true;
  }
  let canonicalCache: string;
  try {
    canonicalCache = realpathSync.native(resolveCacheDir(cacheDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }
  return foreignLockHoldsSync(canonicalWorkspaceLockPath(canonicalCache, canonicalRoot));
}

export async function loadIndex(
  root: string,
  options?: LoadIndexOptions,
): Promise<OsnovaIndex | undefined> {
  const absRoot = workspaceIdentity(root);
  return loadArtifact(absRoot, resolveCacheDir(options?.cacheDir));
}
