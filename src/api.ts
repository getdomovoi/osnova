import path from "node:path";
import { loadArtifact } from "./index/serialize.js";
import { resolveCacheDir } from "./cache/cache.js";
import type { LoadIndexOptions, OsnovaIndex } from "./types.js";

export async function loadIndex(
  root: string,
  options?: LoadIndexOptions,
): Promise<OsnovaIndex | undefined> {
  const absRoot = path.resolve(root);
  return loadArtifact(absRoot, resolveCacheDir(options?.cacheDir));
}
