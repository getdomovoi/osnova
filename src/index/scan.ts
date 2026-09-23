import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { promises as fs } from "node:fs";
import path from "node:path";
import ignore from "ignore";
import type { Ignore } from "ignore";
import { maximumIndexedFileSizeBytes } from "../types.js";
import { IndexingError } from "./diagnostics.js";
import { canonicalWorkspaceRoot } from "./workspace.js";

export const DEFAULT_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".next",
  ".turbo",
  ".cache",
  ".gradle",
  "obj",
  ".idea",
]);

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sourceText(buffer: Buffer): string | null {
  return buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0) || !isUtf8(buffer) ? null : buffer.toString("utf8");
}

export const maximumIgnoreFileBytes = 1_000_000;
export const maximumIgnorePatterns = 10_000;

async function loadIgnoreFile(absPath: string, relPath: string): Promise<string[]> {
  const tooLarge = () => new IndexingError({ phase: "scan", path: relPath, code: "ignore-file-too-large" });
  try {
    const stat = await fs.lstat(absPath);
    if (stat.isSymbolicLink()) throw new Error("ignore file must not be a symlink");
    if (stat.size > maximumIgnoreFileBytes) throw tooLarge();
    const buffer = await fs.readFile(absPath);
    if (buffer.length > maximumIgnoreFileBytes) throw tooLarge();
    return buffer.toString("utf8").split("\n");
  } catch (error) {
    if (error instanceof IndexingError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new IndexingError({ phase: "scan", path: relPath, code: "ignore-unreadable" }, error);
  }
}

export interface ScanResult {
  readonly paths: string[];
  readonly truncated: number;
  readonly metadata: ReadonlyMap<string, FileMetadata>;
  readonly symlinkedDirectories: readonly string[];
}

export interface FileMetadata {
  readonly size: number;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly ino: string;
  readonly dev: string;
}

export function sameFileMetadata(a: FileMetadata | undefined, b: FileMetadata | undefined): boolean {
  return a !== undefined && b !== undefined && a.size === b.size && a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs && a.ino === b.ino && a.dev === b.dev;
}

export async function scanFiles(absRoot: string, cacheDir?: string): Promise<ScanResult> {
  absRoot = await canonicalWorkspaceRoot(absRoot);

  const errors: IndexingError[] = [];
  const results: Array<{ rel: string; metadata: FileMetadata }> = [];
  const symlinkedDirectories: string[] = [];
  let truncated = 0;
  let ignorePatterns = 0;

  const limited = (limit: number) => {
    let active = 0;
    const queue: Array<() => void> = [];
    return async <T>(job: () => Promise<T>): Promise<T> => {
      while (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
      active += 1;
      try { return await job(); } finally { active -= 1; queue.shift()?.(); }
    };
  };
  const dirGate = limited(8);
  const fileGate = limited(64);

  const fail = (diagnostic: IndexingError["diagnostic"], cause: unknown): void => {
    errors.push(new IndexingError(diagnostic, cause));
  };

  const walk = async (dir: string, relDir: string, inherited: readonly { base: string; rules: Ignore }[]): Promise<void> => {
    let entries;
    const rules = ignore();
    let patterned = false;
    try {
      entries = await dirGate(async () => {
        const dirEntries = await fs.readdir(dir, { withFileTypes: true });
        const names = new Set(dirEntries.map((entry) => entry.name));
        for (const name of [".gitignore", ".osnovaignore"]) {
          if (!names.has(name)) continue;
          const relPath = relDir ? `${relDir}/${name}` : name;
          const lines = await loadIgnoreFile(path.join(dir, name), relPath);
          const patterns = lines.filter((line) => { const text = line.trim(); return text.length > 0 && !text.startsWith("#"); }).length;
          ignorePatterns += patterns;
          if (ignorePatterns > maximumIgnorePatterns) throw new IndexingError({ phase: "scan", path: relPath, code: "ignore-pattern-limit" });
          if (patterns > 0) patterned = true;
          rules.add(lines);
        }
        return dirEntries;
      });
    } catch (error) {
      if (error instanceof IndexingError) { fail(error.diagnostic, error.cause); return; }
      fail({ phase: "scan", path: relDir || ".", code: "directory-unreadable" }, error);
      return;
    }
    const layers = patterned ? [...inherited, { base: relDir === "" ? "" : `${relDir}/`, rules }] : inherited;
    const ignored = (relative: string): boolean => {
      if (layers.length === 0) return false;
      let excluded = false;
      for (const layer of layers) {
        const result = layer.rules.test(relative.slice(layer.base.length));
        if (result.ignored) excluded = true;
        else if (result.unignored) excluded = false;
      }
      return excluded;
    };
    const pending: Promise<void>[] = [];
    for (const entry of entries) {
      const rel = relDir.length > 0 ? `${relDir}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      const isCacheEntry = abs === cacheDir || (dir === cacheDir && /^[0-9a-f]{16}(?:\.lock(?:\.abandoned-[0-9a-f-]+)?)?$/.test(entry.name));
      if (entry.isDirectory()) {
        if (isCacheEntry) continue;
        if (DEFAULT_SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith(".")) continue;
        if (ignored(`${rel}/`)) continue;
        pending.push(walk(abs, rel, layers));
        continue;
      }
      if (entry.isSymbolicLink()) {
        if (isCacheEntry) continue;
        if (DEFAULT_SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith(".")) continue;
        pending.push(dirGate(async () => {
          let stat;
          try {
            stat = await fs.stat(abs);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT" || code === "ENOTDIR") return;
            fail({ phase: "scan", path: rel, code: "stat-failed" }, error);
            return;
          }
          if (!stat.isDirectory()) return;
          if (ignored(`${rel}/`)) return;
          symlinkedDirectories.push(rel);
        }));
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.startsWith(".")) continue;
      if (entry.name !== "package.json" && ignored(rel)) continue;
      pending.push(fileGate(async () => {
        let stat;
        try { stat = await fs.stat(abs, { bigint: true }); } catch (error) { fail({ phase: "scan", path: rel, code: "stat-failed" }, error); return; }
        if (stat.size > BigInt(maximumIndexedFileSizeBytes)) { truncated += 1; return; }
        results.push({ rel, metadata: { size: Number(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs), ino: String(stat.ino), dev: String(stat.dev) } });
      }));
    }
    await Promise.all(pending);
  };

  await walk(absRoot, "", []);
  if (errors.length > 0) {
    errors.sort((a, b) => (a.diagnostic.path < b.diagnostic.path ? -1 : a.diagnostic.path > b.diagnostic.path ? 1 : 0));
    throw errors[0];
  }
  results.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const paths = results.map((item) => item.rel);
  const metadata = new Map(results.map((item) => [item.rel, item.metadata]));
  symlinkedDirectories.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { paths, truncated, metadata, symlinkedDirectories };
}
