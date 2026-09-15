import { promises as fs } from "node:fs";
import { loadArtifact, saveArtifact, serializeArtifact, extractionVersion, artifactPathFor } from "./index/serialize.js";
import { resolveCacheDir, workspaceLockPath, workspaceKey, cacheLimits, evictLru } from "./cache/cache.js";
import type { LoadIndexOptions, OsnovaIndex } from "./types.js";
import { canonicalWorkspaceRoot, workspaceIdentity, validRelativePath } from "./index/workspace.js";
import type { WorkspaceOptions } from "./index/workspace.js";
import { withCacheLock } from "./cache/lock.js";
import { buildIndexSnapshot } from "./index/build.js";
import { applyFreshnessReport, inspectFreshness, isStale } from "./index/incremental.js";
import { loadVerification, saveVerification } from "./index/verification.js";
import { IndexingError } from "./index/diagnostics.js";
import { knownIndexGeneration, rememberIndexGeneration } from "./index/generation.js";

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

const refreshing = new Map<string, Promise<OsnovaIndex>>();

export async function refreshWorkspace(root: string, options: WorkspaceOptions = {}): Promise<OsnovaIndex> {
  const canonicalRoot = await canonicalWorkspaceRoot(root);
  const limits = cacheLimits(options);
  const cacheDir = resolveCacheDir(options.cacheDir);
  try {
    await fs.mkdir(cacheDir, { recursive: true });
  } catch (error) {
    throw new IndexingError({ phase: "cache", path: cacheDir, code: "cache-write-failed" }, error);
  }
  const canonicalCache = await fs.realpath(cacheDir);
  const key = JSON.stringify([canonicalCache, canonicalRoot, limits, options.lockTimeoutMs, options.lockPollMs]);
  const running = refreshing.get(key);
  if (running !== undefined) return running;
  const task = withCacheLock(workspaceLockPath(canonicalCache, canonicalRoot), async () => {
    let index: OsnovaIndex | undefined = await loadArtifact(canonicalRoot, canonicalCache);
    let dirty = index === undefined;
    let verified = index === undefined ? undefined : (await loadVerification(canonicalCache, canonicalRoot, indexGeneration(index)))?.files;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      index ??= await buildIndexSnapshot(canonicalRoot, options.onProgress, canonicalCache);
      const inspection = await inspectFreshness(index, canonicalRoot, verified);
      const report = inspection.report;
      if (!isStale(report)) {
        if (dirty) await saveArtifact(index, canonicalCache, options);
        else {
          const artifact = await artifactPathFor(canonicalRoot, canonicalCache);
          if (limits.maxWorkspaces === 0 || artifact === undefined || (await fs.stat(artifact)).size > limits.maxBytes) {
            throw new IndexingError({ phase: "cache", path: canonicalCache, code: "cache-limit-exceeded" });
          }
          await evictLru(canonicalCache, options);
        }
        try {
          await saveVerification(canonicalCache, canonicalRoot, indexGeneration(index), inspection.metadata);
        } catch (error) {
          throw new IndexingError({ phase: "cache", path: canonicalCache, code: "verification-write-failed" }, error);
        }
        return index;
      }
      index = await applyFreshnessReport(index, canonicalRoot, [...report.added, ...report.changed, ...report.deleted], report);
      verified = inspection.metadata;
      dirty = true;
    }
    throw new IndexingError({ phase: "scan", path: canonicalRoot, code: "workspace-changing" });
  }, options);
  refreshing.set(key, task);
  try {
    return await task;
  } finally {
    if (refreshing.get(key) === task) refreshing.delete(key);
  }
}

export async function loadIndex(
  root: string,
  options?: LoadIndexOptions,
): Promise<OsnovaIndex | undefined> {
  const absRoot = workspaceIdentity(root);
  return loadArtifact(absRoot, resolveCacheDir(options?.cacheDir));
}
