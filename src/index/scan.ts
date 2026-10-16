import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { createReadStream, promises as fs } from "node:fs";
import type { BigIntStats } from "node:fs";
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

export async function sha256File(absPath: string): Promise<{ hash: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(absPath)) { hash.update(chunk as Buffer); size += (chunk as Buffer).length; }
  return { hash: hash.digest("hex"), size };
}

export function sourceText(buffer: Buffer): string | null {
  return buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0) || !isUtf8(buffer) ? null : buffer.toString("utf8");
}

export const maximumIgnoreFileBytes = 1_000_000;
export const maximumIgnorePatterns = 10_000;

async function loadIgnoreFile(absPath: string, relPath: string): Promise<{ lines: string[]; metadata?: FileMetadata | undefined }> {
  const tooLarge = () => new IndexingError({ phase: "scan", path: relPath, code: "ignore-file-too-large" });
  try {
    const stat = await fs.lstat(absPath, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error("ignore file must not be a symlink");
    if (stat.size > BigInt(maximumIgnoreFileBytes)) throw tooLarge();
    const buffer = await fs.readFile(absPath);
    if (buffer.length > maximumIgnoreFileBytes) throw tooLarge();
    return { lines: buffer.toString("utf8").split("\n"), metadata: metadataOf(stat) };
  } catch (error) {
    if (error instanceof IndexingError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { lines: [] };
    throw new IndexingError({ phase: "scan", path: relPath, code: "ignore-unreadable" }, error);
  }
}

export interface OversizedFile {
  readonly path: string;
  readonly size: number;
}

export interface ScanResult {
  readonly paths: string[];
  readonly truncated: number;
  readonly oversized: readonly OversizedFile[];
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

function metadataOf(stat: BigIntStats): FileMetadata {
  return { size: Number(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs), ino: String(stat.ino), dev: String(stat.dev) };
}

// Everything a scan's result depends on, each taken before it was read: the canonical root, the walked directories
// (whose listings decide which paths exist), the ignore files read, each followed symlink's target kind and each
// file's metadata. While all of it still stats the same, a new scan would return the same paths and metadata. serial
// is the scan's place among the scans this process started, taken as it began, so a caller can tell whether the scan
// began after something it observed; scanSerial is the serial of the latest scan started.
export interface ScanWitness {
  readonly serial: number;
  readonly root: string;
  readonly directories: ReadonlyMap<string, FileMetadata>;
  readonly ignoreFiles: ReadonlyMap<string, FileMetadata>;
  readonly symlinkDirectories: ReadonlyMap<string, boolean>;
  readonly files: ReadonlyMap<string, FileMetadata>;
}

const limited = (limit: number) => {
  let active = 0;
  const queue: Array<() => void> = [];
  return async <T>(job: () => Promise<T>): Promise<T> => {
    while (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active += 1;
    try { return await job(); } finally { active -= 1; queue.shift()?.(); }
  };
};

const missingEntry = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
};

let scansStarted = 0;

export function scanSerial(): number {
  return scansStarted;
}

const witnessBatch = 1_024;

// Stats what the witness recorded and nothing else: no directory listing, ignore parsing or hashing. Any difference,
// or any failure to stat, means the tree may have changed and only a full scan can say how.
export async function witnessHolds(root: string, witness: ScanWitness): Promise<boolean> {
  try {
    if (await fs.realpath(root) !== witness.root) return false;
  } catch {
    return false;
  }
  const absolute = (rel: string): string => (rel.length === 0 ? witness.root : path.join(witness.root, rel));
  const statsSame = async (abs: string, expected: FileMetadata): Promise<boolean> => sameFileMetadata(metadataOf(await fs.stat(abs, { bigint: true })), expected);
  const checks: Array<() => Promise<boolean>> = [];
  for (const [rel, expected] of witness.directories) checks.push(() => statsSame(absolute(rel), expected));
  for (const [rel, expected] of witness.ignoreFiles) checks.push(async () => sameFileMetadata(metadataOf(await fs.lstat(absolute(rel), { bigint: true })), expected));
  for (const [rel, expected] of witness.files) checks.push(() => statsSame(absolute(rel), expected));
  for (const [rel, expected] of witness.symlinkDirectories) {
    checks.push(async () => {
      const stat = await fs.stat(absolute(rel)).catch((error: unknown) => { if (missingEntry(error)) return undefined; throw error; });
      return (stat?.isDirectory() ?? false) === expected;
    });
  }
  // Whole batches go to the thread pool at once: a bounded number of checks in flight waited on each round trip and
  // cost several times as much as the stats themselves.
  for (let start = 0; start < checks.length; start += witnessBatch) {
    const batch = await Promise.all(checks.slice(start, start + witnessBatch).map((same) => same().catch(() => false)));
    if (batch.includes(false)) return false;
  }
  return true;
}

export async function scanFiles(absRoot: string, cacheDir?: string): Promise<ScanResult> {
  return (await scanWorkspace(absRoot, cacheDir)).scan;
}

export async function scanWorkspace(absRoot: string, cacheDir?: string): Promise<{ scan: ScanResult; witness: ScanWitness }> {
  scansStarted += 1;
  const serial = scansStarted;
  absRoot = await canonicalWorkspaceRoot(absRoot);

  const errors: IndexingError[] = [];
  const results: Array<{ rel: string; metadata: FileMetadata }> = [];
  const symlinkedDirectories: string[] = [];
  const oversized: OversizedFile[] = [];
  const directories = new Map<string, FileMetadata>();
  const ignoreFiles = new Map<string, FileMetadata>();
  const symlinkDirectories = new Map<string, boolean>();
  let ignorePatterns = 0;

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
        directories.set(relDir, metadataOf(await fs.stat(dir, { bigint: true })));
        const dirEntries = await fs.readdir(dir, { withFileTypes: true });
        const names = new Set(dirEntries.map((entry) => entry.name));
        for (const name of [".gitignore", ".osnovaignore"]) {
          if (!names.has(name)) continue;
          const relPath = relDir ? `${relDir}/${name}` : name;
          const { lines, metadata } = await loadIgnoreFile(path.join(dir, name), relPath);
          if (metadata !== undefined) ignoreFiles.set(relPath, metadata);
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
            if (missingEntry(error)) { symlinkDirectories.set(rel, false); return; }
            fail({ phase: "scan", path: rel, code: "stat-failed" }, error);
            return;
          }
          symlinkDirectories.set(rel, stat.isDirectory());
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
        if (stat.size > BigInt(maximumIndexedFileSizeBytes)) oversized.push({ path: rel, size: Number(stat.size) });
        results.push({ rel, metadata: metadataOf(stat) });
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
  oversized.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    scan: { paths, truncated: oversized.length, oversized, metadata, symlinkedDirectories },
    witness: { serial, root: absRoot, directories, ignoreFiles, symlinkDirectories, files: metadata },
  };
}
