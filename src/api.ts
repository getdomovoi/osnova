import { promises as fs } from "node:fs";
import path from "node:path";
import { loadArtifact, saveArtifact, serializeArtifact, extractionVersion, artifactPathFor, artifactTextPathFor, artifactEdgesPathFor, isSectionInconsistency } from "./index/serialize.js";
import { resolveCacheDir, workspaceDirFor, workspaceLockPath, workspaceKey, cacheLimits, evictLru } from "./cache/cache.js";
import type { LoadIndexOptions, OsnovaIndex } from "./types.js";
import { canonicalWorkspaceRoot, workspaceIdentity, validRelativePath } from "./index/workspace.js";
import type { WorkspaceOptions } from "./index/workspace.js";
import { withCacheLock } from "./cache/lock.js";
import { buildIndexSnapshot } from "./index/build.js";
import { applyFreshnessReport, inspectFreshness, isStale } from "./index/incremental.js";
import { loadVerification, saveVerification } from "./index/verification.js";
import { scanFiles, sameFileMetadata } from "./index/scan.js";
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
  const canonicalRoot = await canonicalWorkspaceRoot(root);
  const limits = cacheLimits(options);
  const cacheDir = resolveCacheDir(options.cacheDir);
  try {
    await fs.mkdir(cacheDir, { recursive: true });
  } catch (error) {
    throw new IndexingError({ phase: "cache", path: cacheDir, code: "cache-write-failed" }, error);
  }
  const canonicalCache = await fs.realpath(cacheDir);
  const indexKey = JSON.stringify([canonicalCache, canonicalRoot]);
  const taskKey = JSON.stringify([indexKey, limits, options.lockTimeoutMs, options.lockPollMs, options.reuseMemory]);
  const running = refreshing.get(taskKey);
  if (running !== undefined) return running;
  const task = withCacheLock(workspaceLockPath(canonicalCache, canonicalRoot), async () => {
    const published = await artifactSignature(canonicalRoot, canonicalCache);
    const cached = loadedIndexes.get(indexKey);
    const generation = await readGeneration(canonicalRoot, canonicalCache);
    const verified = generation === undefined ? undefined : (await loadVerification(canonicalCache, canonicalRoot, generation))?.files;
    const scan = await scanFiles(canonicalRoot, canonicalCache);
    const clean = verified !== undefined && scan.paths.length === verified.size &&
      scan.paths.every((p) => sameFileMetadata(verified.get(p), scan.metadata.get(p)));
    let index: OsnovaIndex | undefined;
    if (options.reuseMemory === true && cached !== undefined && cached.artifact === published) {
      index = cached.index;
    } else if (clean || generation !== undefined) {
      try {
        index = await loadArtifact(canonicalRoot, canonicalCache);
      } catch (error) {
        if (!isSectionInconsistency(error)) throw error;
        index = undefined;
      }
    }
    let dirty = index === undefined;
    let known = index === undefined || indexGeneration(index) !== generation ? undefined : verified;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      index ??= await buildIndexSnapshot(canonicalRoot, options.onProgress, canonicalCache);
      const inspection = clean && known !== undefined && attempt === 0 && !dirty
        ? { report: { added: [], changed: [], deleted: [] }, metadata: scan.metadata, hashedFiles: 0 }
        : await inspectFreshness(index, canonicalRoot, known, attempt === 0 ? scan : undefined);
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
        if (options.reuseMemory === true) {
          rememberLoaded(indexKey, index, await artifactSignature(canonicalRoot, canonicalCache), limits.maxWorkspaces);
        }
        return index;
      }
      index = await applyFreshnessReport(index, canonicalRoot, [...report.added, ...report.changed, ...report.deleted], report);
      known = inspection.metadata;
      dirty = true;
    }
    throw new IndexingError({ phase: "scan", path: canonicalRoot, code: "workspace-changing" });
  }, options);
  refreshing.set(taskKey, task);
  try {
    return await task;
  } finally {
    if (refreshing.get(taskKey) === task) refreshing.delete(taskKey);
  }
}

export async function loadIndex(
  root: string,
  options?: LoadIndexOptions,
): Promise<OsnovaIndex | undefined> {
  const absRoot = workspaceIdentity(root);
  return loadArtifact(absRoot, resolveCacheDir(options?.cacheDir));
}
