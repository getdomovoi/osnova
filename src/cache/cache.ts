import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { workspaceIdentity } from "../index/workspace.js";
import { CacheLockTimeoutError, holdsCacheLock, sweepLockDebris, withCacheLock } from "./lock.js";

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
  return createHash("sha256").update(workspaceIdentity(absRoot)).digest("hex").slice(0, 16);
}

export function workspaceDirFor(cacheDir: string, absRoot: string): string {
  return path.join(cacheDir, workspaceKey(absRoot));
}

export const defaultLruCap = 32;
export const defaultCacheMaxBytes = 256 * 1024 * 1024;

export interface CachePolicy {
  readonly maxWorkspaces?: number | undefined;
  readonly maxBytes?: number | undefined;
}

export function cacheLimits(policy: CachePolicy = {}): { maxWorkspaces: number; maxBytes: number } {
  const maxWorkspaces = policy.maxWorkspaces ?? defaultLruCap;
  const maxBytes = policy.maxBytes ?? defaultCacheMaxBytes;
  if (!Number.isSafeInteger(maxWorkspaces) || maxWorkspaces < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("osnova: cache limits must be nonnegative safe integers");
  }
  return { maxWorkspaces, maxBytes };
}

export function workspaceLockPath(cacheDir: string, root: string): string {
  return `${workspaceDirFor(cacheDir, root)}.lock`;
}

export async function touchWorkspace(dir: string): Promise<void> {
  const cacheDir = path.dirname(dir);
  await withCacheLock(path.join(cacheDir, ".eviction.lock"), async () => {
    let latest = Date.now();
    for (const entry of await fs.readdir(cacheDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !WORKSPACE_KEY_RE.test(entry.name)) continue;
      try {
        const value = Number(await fs.readFile(path.join(cacheDir, entry.name, "access"), "utf8"));
        if (!Number.isSafeInteger(value) || value <= 0) throw new Error("osnova: corrupt cache access metadata");
        latest = Math.max(latest, value + 1);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const temporary = path.join(dir, `access.tmp-${randomUUID()}`);
    try {
      await fs.writeFile(temporary, String(latest), { flag: "wx" });
      await fs.rename(temporary, path.join(dir, "access"));
    } finally {
      await fs.rm(temporary, { force: true });
    }
  });
}

async function removeBaseTrees(base: string): Promise<void> {
  await sweepLockDebris(base);
  for (const name of await fs.readdir(base)) {
    if (name === ".lock" || name.startsWith(".lock.")) continue;
    await fs.rm(path.join(base, name), { recursive: true, force: true });
  }
}

async function removeIfEmpty(dir: string): Promise<void> {
  try {
    await fs.rmdir(dir);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

export async function evictLru(cacheDir: string, policy: number | CachePolicy = defaultLruCap): Promise<void> {
  const limits = cacheLimits(typeof policy === "number" ? { maxWorkspaces: policy } : policy);
  await withCacheLock(path.join(cacheDir, ".eviction.lock"), async () => {
    let entries;
    try {
      entries = await fs.readdir(cacheDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await sweepLockDebris(cacheDir);
    const candidates: Array<{ dir: string; access: number; bytes: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !WORKSPACE_KEY_RE.test(entry.name)) continue;
      const dir = path.join(cacheDir, entry.name);
      try {
        const artifacts = await fs.readdir(dir);
        let bytes = 0;
        let access = 0;
        for (const name of artifacts.filter((name) => name === "index.json" || name === "index.json.gz" || name === "text.bin" || name === "edges.json" || name === "index.sha")) {
          const stat = await fs.lstat(path.join(dir, name));
          if (!stat.isFile()) throw new Error("osnova: cache artifact is not a regular file");
          bytes += stat.size;
          access = Math.max(access, stat.mtimeMs);
        }
        if (bytes === 0) continue;
        try {
          const value = Number(await fs.readFile(path.join(dir, "access"), "utf8"));
          if (!Number.isFinite(value) || value <= 0) throw new Error("osnova: corrupt cache access metadata");
          access = value;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        candidates.push({ dir, access, bytes });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    candidates.sort((a, b) => a.access - b.access || (a.dir < b.dir ? -1 : 1));
    let count = candidates.length;
    let bytes = candidates.reduce((sum, item) => sum + item.bytes, 0);
    for (const victim of candidates) {
      if (count <= limits.maxWorkspaces && bytes <= limits.maxBytes) break;
      if (holdsCacheLock(`${victim.dir}.lock`)) continue;
      try {
        await withCacheLock(`${victim.dir}.lock`, async () => {
          const names = await fs.readdir(victim.dir);
          const owned = names.filter((name) => ["index.json", "index.json.gz", "text.bin", "edges.json", "index.sha", "access", "verification.json", "base", "family.json"].includes(name));
          const access = Number(await fs.readFile(path.join(victim.dir, "access"), "utf8").catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return "0";
            throw error;
          }));
          if (access > victim.access) return;
          const base = path.join(victim.dir, "base");
          const remove = async (): Promise<void> => {
            for (const name of owned) {
              if (name === "base") await removeBaseTrees(base);
              else await fs.rm(path.join(victim.dir, name), { force: true });
            }
          };
          // Base trees are written under their own lock, not the workspace lock, so a victim whose
          // base lock is busy is skipped like a victim whose workspace lock is busy.
          if (owned.includes("base")) await withCacheLock(path.join(base, ".lock"), remove, { lockTimeoutMs: 0 });
          else await remove();
          if (owned.includes("base")) await removeIfEmpty(base);
          if (owned.length === names.length) await removeIfEmpty(victim.dir);
          count -= 1;
          bytes -= victim.bytes;
        }, { lockTimeoutMs: 0 });
      } catch (error) {
        if (!(error instanceof CacheLockTimeoutError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  });
}
