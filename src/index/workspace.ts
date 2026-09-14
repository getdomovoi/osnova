import path from "node:path";
import { promises as fs, realpathSync } from "node:fs";
import { IndexingError } from "./diagnostics.js";
import type { BuildOptions, OsnovaIndex } from "../types.js";
import type { CachePolicy } from "../cache/cache.js";
import type { LockOptions } from "../cache/lock.js";

export interface WorkspaceOptions extends BuildOptions, CachePolicy, LockOptions {}

const indexCaches = new WeakMap<OsnovaIndex, string>();

export function indexCacheDirectory(index: OsnovaIndex): string | undefined {
  return indexCaches.get(index);
}

export function bindIndexCache<T extends OsnovaIndex>(index: T, cacheDir: string | undefined): T {
  if (cacheDir !== undefined) indexCaches.set(index, workspaceIdentity(cacheDir));
  return index;
}

export function workspaceIdentity(root: string): string {
  let ancestor = path.resolve(root);
  const suffix: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(ancestor), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

export async function canonicalWorkspaceRoot(root: string): Promise<string> {
  try {
    const canonical = await fs.realpath(root);
    if (!(await fs.stat(canonical)).isDirectory()) throw new Error("workspace root is not a directory");
    return canonical;
  } catch (error) {
    throw new IndexingError({ phase: "scan", path: root, code: "directory-unreadable" }, error);
  }
}

export function validRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") &&
    !value.includes("\\") && !path.posix.isAbsolute(value) && !/^[A-Za-z]:/.test(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function workspaceRelativePath(root: string, inputRoot: string, file: string): string {
  if (file.includes("\0") || (path.sep !== "\\" && file.includes("\\"))) {
    throw new Error(`osnova: invalid workspace path ${JSON.stringify(file)}`);
  }
  const absolute = path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file);
  let relative = path.relative(root, absolute);
  if (path.isAbsolute(file) && (relative === ".." || relative.startsWith(`..${path.sep}`))) {
    relative = path.relative(path.resolve(inputRoot), absolute);
  }
  const normalized = relative.split(path.sep).join("/");
  if (normalized === "") return ".";
  if (!validRelativePath(normalized)) throw new Error(`osnova: path escapes outside workspace: ${JSON.stringify(file)}`);
  return normalized;
}

export async function workspaceFilePath(root: string, relative: string): Promise<string> {
  if (!validRelativePath(relative)) throw new Error(`osnova: invalid workspace path ${JSON.stringify(relative)}`);
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) {
      throw new IndexingError({ phase: "read", path: relative, code: "symlink-not-indexed" });
    }
  }
  return current;
}
