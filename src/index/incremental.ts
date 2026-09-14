import path from "node:path";
import { promises as fs } from "node:fs";
import type { FreshnessReport, OsnovaIndex } from "../types.js";
import { localOfQualifiedName } from "./indexImpl.js";
import type { RawEdgeItem } from "./indexImpl.js";
import { extractCard, finalizeIndex } from "./build.js";
import { scanFiles, sha256Hex } from "./scan.js";
import { IndexingError } from "./diagnostics.js";

export async function freshness(index: OsnovaIndex, root: string): Promise<FreshnessReport> {
  const absRoot = path.resolve(root);
  if (index.root !== absRoot) {
    throw new Error(
      `osnova: index belongs to ${index.root}, not ${absRoot}; rebuild with buildIndex(${JSON.stringify(absRoot)})`,
    );
  }
  const scan = await scanFiles(absRoot);
  const current = new Set(scan.paths);
  const added: string[] = [];
  const changed: string[] = [];
  const deleted: string[] = [];

  for (const relPath of scan.paths) {
    const card = index.files.get(relPath);
    if (card === undefined) {
      added.push(relPath);
      continue;
    }
    try {
      const buffer = await fs.readFile(path.join(absRoot, relPath));
      if (sha256Hex(buffer) !== card.hash) changed.push(relPath);
    } catch (error) {
      throw new IndexingError({ phase: "read", path: relPath, code: "file-unreadable" }, error);
    }
  }
  for (const existing of index.files.keys()) {
    if (!current.has(existing)) deleted.push(existing);
  }
  added.sort();
  changed.sort();
  deleted.sort();
  return { added, changed, deleted };
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

function normalizeRelPath(nativePath: string): string {
  const posix = nativePath.split(path.sep).join("/");
  const normalized = path.posix.normalize(posix);
  if (normalized.startsWith("..") || path.posix.isAbsolute(normalized)) return "";
  return normalized;
}

export async function applyChanges(
  index: OsnovaIndex,
  root: string,
  paths: Iterable<string>,
): Promise<OsnovaIndex> {
  const absRoot = path.resolve(root);
  if (index.root !== absRoot) {
    throw new Error(
      `osnova: index belongs to ${index.root}, not ${absRoot}; rebuild with buildIndex(${JSON.stringify(absRoot)})`,
    );
  }
  const files = new Map(index.files);
  const rawEdges = rawEdgesFromIndex(index);
  const normalized = [...new Set([...paths].map(normalizeRelPath))].filter((p) => p.length > 0).sort();
  if (normalized.length === 0) return index;

  const scan = await scanFiles(absRoot);
  const eligible = new Set(scan.paths);

  for (const relPath of normalized) {
    if (!eligible.has(relPath)) {
      files.delete(relPath);
      rawEdges.delete(relPath);
      continue;
    }
    const { card, rawEdges: fileEdges } = await extractCard(absRoot, relPath);
    files.set(relPath, card);
    if (fileEdges.length > 0) rawEdges.set(relPath, fileEdges);
    else rawEdges.delete(relPath);
  }

  return finalizeIndex(absRoot, files, rawEdges);
}
