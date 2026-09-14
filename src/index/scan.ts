import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import ignore from "ignore";
import { maximumIndexedFileSizeBytes } from "../types.js";

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

async function loadIgnoreFile(absPath: string): Promise<string[]> {
  try {
    const content = await fs.readFile(absPath, "utf8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } catch {
    return [];
  }
}

export interface ScanResult {
  readonly paths: string[];
  readonly truncated: number;
}

export async function scanFiles(absRoot: string): Promise<ScanResult> {
  const ig = ignore();
  const gitignoreLines = await loadIgnoreFile(path.join(absRoot, ".gitignore"));
  const osnovaIgnoreLines = await loadIgnoreFile(path.join(absRoot, ".osnovaignore"));
  ig.add(gitignoreLines);
  ig.add(osnovaIgnoreLines);

  const paths: string[] = [];
  let truncated = 0;

  const walk = async (dir: string, relDir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relDir.length > 0 ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (DEFAULT_SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith(".") && entry.name !== ".") continue;
        if (ig.ignores(`${rel}/`)) continue;
        await walk(path.join(dir, entry.name), rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.startsWith(".")) continue;
      if (ig.ignores(rel)) continue;
      let stat;
      try {
        stat = await fs.stat(path.join(dir, entry.name));
      } catch {
        continue;
      }
      if (stat.size > maximumIndexedFileSizeBytes) {
        truncated += 1;
        continue;
      }
      paths.push(rel);
    }
  };

  await walk(absRoot, "");
  paths.sort();
  return { paths, truncated };
}
