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

async function artifactSignature(root: string, cacheDir: string): Promise<string | undefined> {
  const artifact = await artifactPathFor(root, cacheDir);
  const edges = await artifactEdgesPathFor(root, cacheDir);
  const text = await artifactTextPathFor(root, cacheDir);
  if (artifact === undefined || edges === undefined || text === undefined) return undefined;
  const parts: string[] = [];
  for (const file of [artifact, edges, text]) {
    const stat = await fs.stat(file, { bigint: true });
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

async function readGeneration(root: string, cacheDir: string): Promise<string | undefined> {
  const file = path.join(workspaceDirFor(cacheDir, root), "index.sha");
  try {
    return (await fs.readFile(file, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
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
  try {
    await fs.mkdir(cacheDir, { recursive: true });
  } catch (error) {
    throw new IndexingError({ phase: "cache", path: cacheDir, code: "cache-write-failed" }, error);
  }
  const canonicalCache = await fs.realpath(cacheDir);
  const indexKey = JSON.stringify([canonicalCache, canonicalRoot]);
  const rebuild = options.rebuild === true;
  const taskKey = JSON.stringify([indexKey, limits, options.lockTimeoutMs, options.lockPollMs, options.reuseMemory, rebuild]);
  const running = refreshing.get(taskKey);
  if (running !== undefined) return running;
  // The coalescing key and the lock both name the root resolved above, never what the path resolves to later. A root
  // retargeted since then, or by the time the scan resolves it again, is not the root this lock covers, so the refresh
  // fails instead. Loading and building resolve the path again after the scan, so an index of another root, or one read
  // through a retargeted path, fails the refresh before its files are inspected or anything is written. An index the
  // scan verified unchanged reads no source after the scan and skips those rechecks. Cache paths inside the lock
  // resolve the root again too, and a retarget undone between two of these checks is not seen.
  const rootMoved = async (): Promise<boolean> => await canonicalWorkspaceRoot(canonicalRoot) !== canonicalRoot;
  const task = withCacheLock(canonicalWorkspaceLockPath(canonicalCache, canonicalRoot), async () => {
    if (await rootMoved()) throw new IndexingError({ phase: "scan", path: canonicalRoot, code: "workspace-changing" });
    const published = await artifactSignature(canonicalRoot, canonicalCache);
    const cached = loadedIndexes.get(indexKey);
    const generation = await readGeneration(canonicalRoot, canonicalCache);
    const verified = generation === undefined ? undefined : (await loadVerification(canonicalCache, canonicalRoot, generation))?.files;
    const { scan, witness } = await scanWorkspace(canonicalRoot, canonicalCache);
    if (witness.root !== canonicalRoot) throw new IndexingError({ phase: "scan", path: canonicalRoot, code: "workspace-changing" });
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
        index = await loadArtifact(canonicalRoot, canonicalCache);
      } catch (error) {
        if (!isRebuildableCacheFailure(error)) throw error;
        index = undefined;
      }
    }
    const seed = index === undefined && generation === undefined && !rebuild
      ? await seedWorkspace(canonicalRoot, canonicalCache, options)
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
        if (index.root !== canonicalRoot || (!unchanged && await rootMoved())) {
          throw new IndexingError({ phase: "scan", path: canonicalRoot, code: "workspace-changing" });
        }
        const inspection = unchanged
          ? { report: { added: [], changed: [], deleted: [] }, metadata: scan.metadata, hashedFiles: 0 }
          : await inspectFreshness(index, canonicalRoot, known, attempt === 0 ? scan : undefined);
        const report = inspection.report;
        if (seededFrom !== undefined) {
          options.onProgress?.(seedProgress(seededFrom, index.files.size, report));
          seededFrom = undefined;
        }
        if (!isStale(report)) {
          if (!unchanged && await rootMoved()) throw new IndexingError({ phase: "scan", path: canonicalRoot, code: "workspace-changing" });
          if (dirty) await saveArtifact(index, canonicalCache, options);
          else {
            const artifact = await artifactPathFor(canonicalRoot, canonicalCache);
            if (limits.maxWorkspaces === 0 || artifact === undefined || (await fs.stat(artifact)).size > limits.maxBytes) {
              throw new IndexingError({ phase: "cache", path: canonicalCache, code: "cache-limit-exceeded" });
            }
            await evictLru(canonicalCache, options);
          }
          if (!unchanged) {
            try {
              await saveVerification(canonicalCache, canonicalRoot, indexGeneration(index), inspection.metadata);
            } catch (error) {
              throw new IndexingError({ phase: "cache", path: canonicalCache, code: "verification-write-failed" }, error);
            }
          }
          await ensureFamilySidecar(canonicalCache, canonicalRoot, seed?.family, seed !== undefined);
          if (options.reuseMemory === true) {
            rememberLoaded(indexKey, index, await artifactSignature(canonicalRoot, canonicalCache), limits.maxWorkspaces);
          }
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
    throw new IndexingError({ phase: "scan", path: canonicalRoot, code: "workspace-changing" });
  }, options).catch((error: unknown) => {
    // The lock a refresh actually waited on is often a nested one, such as the cache-wide eviction
    // lock, wrapped in a read or write failure that names only the workspace directory.
    throw cacheLockTimeoutIn(error) ?? error;
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
