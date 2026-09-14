import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";

const WORKSPACE_KEY_RE = /^[0-9a-f]{16}$/;

export function resolveCacheDir(explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const env = process.env.OSNOVA_CACHE_DIR;
  if (env !== undefined && env.length > 0) return env;
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "osnova");
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "osnova", "cache");
  }
  const xdg = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  return path.join(xdg, "osnova");
}

export function workspaceKey(absRoot: string): string {
  return createHash("sha256").update(absRoot).digest("hex").slice(0, 16);
}

export function workspaceDirFor(cacheDir: string, absRoot: string): string {
  return path.join(cacheDir, workspaceKey(absRoot));
}

export const defaultLruCap = 8;

export async function evictLru(cacheDir: string, cap: number = defaultLruCap): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(cacheDir, { withFileTypes: true });
  } catch {
    return;
  }
  const candidates: Array<{ dir: string; mtime: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !WORKSPACE_KEY_RE.test(entry.name)) continue;
    const dir = path.join(cacheDir, entry.name);
    const artifact = await newestArtifact(dir);
    if (artifact === undefined) continue;
    try {
      const stat = await fs.stat(artifact);
      candidates.push({ dir, mtime: stat.mtimeMs });
    } catch {
      continue;
    }
  }
  candidates.sort((a, b) => a.mtime - b.mtime);
  for (let i = 0; i < candidates.length - cap; i += 1) {
    const victim = candidates[i];
    if (victim === undefined) continue;
    await fs.rm(victim.dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function newestArtifact(dir: string): Promise<string | undefined> {
  for (const name of ["index.json.gz", "index.json"]) {
    const candidate = path.join(dir, name);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}
