import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { promises as fs } from "node:fs";
import path from "node:path";
import ignore from "ignore";
import type { Ignore } from "ignore";
import { maximumIndexedFileSizeBytes } from "../types.js";
import { IndexingError } from "./diagnostics.js";
import { canonicalWorkspaceRoot, workspaceFilePath } from "./workspace.js";

const DEFAULT_SKIP_DIRS = new Set([
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

async function loadIgnoreFile(absPath: string): Promise<string[]> {
  try {
    if ((await fs.lstat(absPath)).isSymbolicLink()) throw new Error("ignore file must not be a symlink");
    return (await fs.readFile(absPath, "utf8")).split("\n");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new IndexingError({ phase: "scan", path: path.basename(absPath), code: "ignore-unreadable" }, error);
  }
}

export interface ScanResult {
  readonly paths: string[];
  readonly truncated: number;
  readonly metadata: ReadonlyMap<string, FileMetadata>;
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

  const paths: string[] = [];
  const metadata = new Map<string, FileMetadata>();
  let truncated = 0;

  const walk = async (dir: string, relDir: string, inherited: readonly { base: string; rules: Ignore }[]): Promise<void> => {
    if (relDir !== "") dir = await workspaceFilePath(absRoot, relDir);
    const rules = ignore().add(await loadIgnoreFile(path.join(dir, ".gitignore")))
      .add(await loadIgnoreFile(path.join(dir, ".osnovaignore")));
    const layers = [...inherited, { base: relDir === "" ? "" : `${relDir}/`, rules }];
    const ignored = (relative: string): boolean => {
      let excluded = false;
      for (const layer of layers) {
        const result = layer.rules.test(relative.slice(layer.base.length));
        if (result.ignored) excluded = true;
        else if (result.unignored) excluded = false;
      }
      return excluded;
    };
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      throw new IndexingError({ phase: "scan", path: relDir || ".", code: "directory-unreadable" }, error);
    }
    for (const entry of entries) {
      const rel = relDir.length > 0 ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (path.join(dir, entry.name) === cacheDir || (dir === cacheDir && /^[0-9a-f]{16}(?:\.lock(?:\.abandoned-[0-9a-f-]+)?)?$/.test(entry.name))) continue;
        if (DEFAULT_SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith(".") && entry.name !== ".") continue;
        if (ignored(`${rel}/`)) continue;
        await walk(path.join(dir, entry.name), rel, layers);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.startsWith(".")) continue;
      if (ignored(rel)) continue;
      let stat;
      try {
        stat = await fs.stat(path.join(dir, entry.name), { bigint: true });
      } catch (error) {
        throw new IndexingError({ phase: "scan", path: rel, code: "stat-failed" }, error);
      }
      if (stat.size > BigInt(maximumIndexedFileSizeBytes)) {
        truncated += 1;
        continue;
      }
      paths.push(rel);
      metadata.set(rel, {
        size: Number(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs),
        ino: String(stat.ino), dev: String(stat.dev),
      });
    }
  };

  await walk(absRoot, "", []);
  paths.sort();
  return { paths, truncated, metadata };
}
