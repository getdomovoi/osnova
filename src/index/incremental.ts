import { promises as fs } from "node:fs";
import type { FreshnessReport, OsnovaIndex } from "../types.js";
import { localOfQualifiedName } from "./indexImpl.js";
import type { RawEdgeItem } from "./indexImpl.js";
import { extractCard, finalizeIndex } from "./build.js";
import { scanFiles, sameFileMetadata, sha256Hex } from "./scan.js";
import type { FileMetadata } from "./scan.js";
import { IndexingError } from "./diagnostics.js";
import { bindIndexCache, canonicalWorkspaceRoot, indexCacheDirectory, workspaceFilePath, workspaceRelativePath } from "./workspace.js";

export async function freshness(index: OsnovaIndex, root: string): Promise<FreshnessReport> {
  return (await inspectFreshness(index, root)).report;
}

export interface FreshnessInspection {
  readonly report: FreshnessReport;
  readonly metadata: ReadonlyMap<string, FileMetadata>;
  readonly hashedFiles: number;
}

export async function inspectFreshness(
  index: OsnovaIndex,
  root: string,
  verified?: ReadonlyMap<string, FileMetadata>,
): Promise<FreshnessInspection> {
  const absRoot = await canonicalWorkspaceRoot(root);
  if (index.root !== absRoot) {
    throw new Error(
      `osnova: index belongs to ${index.root}, not ${absRoot}; rebuild with buildIndex(${JSON.stringify(absRoot)})`,
    );
  }
  const scan = await scanFiles(absRoot, indexCacheDirectory(index));
  const current = new Set(scan.paths);
  const added: string[] = [];
  const changed: string[] = [];
  const deleted: string[] = [];
  let hashedFiles = 0;

  for (const relPath of scan.paths) {
    const card = index.files.get(relPath);
    if (card === undefined) {
      added.push(relPath);
      continue;
    }
    if (sameFileMetadata(verified?.get(relPath), scan.metadata.get(relPath))) continue;
    try {
      hashedFiles += 1;
      const buffer = await fs.readFile(await workspaceFilePath(absRoot, relPath));
      if (sha256Hex(buffer) !== card.hash || card.size !== buffer.length) changed.push(relPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        deleted.push(relPath);
        continue;
      }
      throw new IndexingError({ phase: "read", path: relPath, code: "file-unreadable" }, error);
    }
  }
  for (const existing of index.files.keys()) {
    if (!current.has(existing)) deleted.push(existing);
  }
  added.sort();
  changed.sort();
  deleted.sort();
  return { report: { added, changed, deleted }, metadata: scan.metadata, hashedFiles };
}

export function isStale(report: FreshnessReport): boolean {
  return report.added.length + report.changed.length + report.deleted.length > 0;
}

function rawEdgesFromIndex(index: OsnovaIndex): Map<string, RawEdgeItem[]> {
  const out = new Map<string, RawEdgeItem[]>();
  for (const edge of index.edges) {
    const raw: RawEdgeItem = {
      kind: edge.kind,
      toName: edge.toName,
      line: edge.line,
      enclosing: localOfQualifiedName(edge.fromSymbol),
      ...(edge.binding === undefined ? {} : { binding: edge.binding }),
    };
    const list = out.get(edge.fromFile);
    if (list === undefined) out.set(edge.fromFile, [raw]);
    else list.push(raw);
  }
  return out;
}

export async function applyChanges(
  index: OsnovaIndex,
  root: string,
  paths: Iterable<string>,
): Promise<OsnovaIndex> {
  const inspection = await inspectFreshness(index, root);
  return applyFreshnessReport(index, root, paths, inspection.report);
}

export async function applyFreshnessReport(
  index: OsnovaIndex,
  root: string,
  paths: Iterable<string>,
  report: FreshnessReport,
): Promise<OsnovaIndex> {
  const absRoot = await canonicalWorkspaceRoot(root);
  if (index.root !== absRoot) {
    throw new Error(
      `osnova: index belongs to ${index.root}, not ${absRoot}; rebuild with buildIndex(${JSON.stringify(absRoot)})`,
    );
  }
  const files = new Map(index.files);
  const rawEdges = rawEdgesFromIndex(index);
  const requested = [...paths].map((file) => workspaceRelativePath(absRoot, root, file));
  for (const file of requested) {
    if (file === ".") continue;
    try {
      await workspaceFilePath(absRoot, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const normalized = [...new Set([...requested, ...report.added, ...report.changed, ...report.deleted])].sort();
  if (normalized.length === 0) return index;
  const deleted = new Set(report.deleted);

  for (const relPath of normalized) {
    if (deleted.has(relPath)) {
      files.delete(relPath);
      rawEdges.delete(relPath);
      continue;
    }
    if (!report.added.includes(relPath) && !report.changed.includes(relPath)) continue;
    const { card, rawEdges: fileEdges } = await extractCard(absRoot, relPath);
    files.set(relPath, card);
    if (fileEdges.length > 0) rawEdges.set(relPath, fileEdges);
    else rawEdges.delete(relPath);
  }

  return bindIndexCache(finalizeIndex(absRoot, files, rawEdges), indexCacheDirectory(index));
}
