import path from "node:path";
import { promises as fs } from "node:fs";
import { getParser } from "../grammar/loader.js";
import { languageForPath } from "../grammar/languages.js";
import { adapterFor } from "../extract/adapters.js";
import { localJoin } from "../extract/util.js";
import type { RawDefinition, RawEdge } from "../extract/adapter.js";
import type {
  BuildOptions,
  CardLanguage,
  FileCard,
  OsnovaIndex,
  OsnovaSymbol,
  ProgressEvent,
  IndexDiagnostic,
} from "../types.js";
import { OsnovaIndexImpl, qualifiedNameOf } from "./indexImpl.js";
import type { RawEdgeItem } from "./indexImpl.js";
import { resolveCacheDir } from "../cache/cache.js";
import { saveArtifact } from "./serialize.js";
import { resolveEdges } from "./resolve.js";
import { scanFiles, sha256Hex } from "./scan.js";
import { IndexingError } from "./diagnostics.js";

const BINARY_SNIFF_BYTES = 8192;

function languageOf(relPath: string): CardLanguage {
  return languageForPath(relPath) ?? "fallback";
}

export async function extractCard(
  absRoot: string,
  relPath: string,
): Promise<{ card: FileCard; rawEdges: RawEdgeItem[] }> {
  const abs = path.join(absRoot, relPath);
  const buffer = await fs.readFile(abs).catch((error: unknown) => {
    throw new IndexingError({ phase: "read", path: relPath, code: "file-unreadable" }, error);
  });
  const hash = sha256Hex(buffer);
  const language = languageOf(relPath);
  const binary = buffer.subarray(0, Math.min(buffer.length, BINARY_SNIFF_BYTES)).includes(0);
  const text = binary ? "" : buffer.toString("utf8");
  const lineCount = text.length === 0 ? 0 : text.split("\n").length;

  if (binary || language === "fallback") {
    const card: FileCard = {
      path: relPath,
      language: binary ? "fallback" : language,
      hash,
      size: buffer.length,
      lineCount,
      text,
      symbols: [],
    };
    return { card, rawEdges: [] };
  }

  let definitions: RawDefinition[] = [];
  let rawEdges: RawEdgeItem[] = [];
  const diagnostics: IndexDiagnostic[] = [];
  const parser = await getParser(language).catch((error: unknown) => {
    throw new IndexingError({ phase: "parse", path: relPath, code: "grammar-unavailable" }, error);
  });
  try {
    const tree = parser.parse(text);
    if (tree !== null) {
      try {
        if (tree.rootNode.hasError) {
          diagnostics.push({ phase: "parse", path: relPath, code: "syntax-errors" });
        }
        const output = adapterFor(language).extract(tree, text);
        definitions = [...output.definitions];
        rawEdges = output.edges.map((edge: RawEdge) => ({
          kind: edge.kind,
          toName: edge.toName,
          line: edge.line,
          enclosing: edge.enclosing,
        }));
      } finally {
        tree.delete();
      }
    } else {
      diagnostics.push({ phase: "parse", path: relPath, code: "empty-parse" });
    }
  } catch {
    definitions = [];
    rawEdges = [];
    diagnostics.push({ phase: "parse", path: relPath, code: "extraction-failed" });
  }

  definitions.sort((a, b) => a.span.startLine - b.span.startLine || a.span.endLine - b.span.endLine || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const symbols: OsnovaSymbol[] = definitions.map((def) => {
    const local = localJoin([def.parent, def.name]);
    return {
      name: def.name,
      qualifiedName: qualifiedNameOf(relPath, local),
      kind: def.kind,
      file: relPath,
      span: def.span,
      signature: def.signature,
      lineCount: Math.max(1, def.span.endLine - def.span.startLine + 1),
    };
  });

  const card: FileCard = {
    path: relPath,
    language,
    hash,
    size: buffer.length,
    lineCount,
    text,
    symbols,
    diagnostics,
  };
  return { card, rawEdges };
}

export function finalizeIndex(
  root: string,
  files: Map<string, FileCard>,
  rawEdges: ReadonlyMap<string, readonly RawEdgeItem[]>,
): OsnovaIndexImpl {
  const edges = resolveEdges({ root, files, rawEdges });
  return new OsnovaIndexImpl(root, files, edges);
}

export async function buildIndex(root: string, options?: BuildOptions): Promise<OsnovaIndex> {
  const absRoot = path.resolve(root);
  const onProgress = options?.onProgress;
  onProgress?.({ phase: "scan", done: 0, total: 0 } satisfies ProgressEvent);
  const scan = await scanFiles(absRoot);
  const files = new Map<string, FileCard>();
  const rawEdges = new Map<string, RawEdgeItem[]>();
  for (let i = 0; i < scan.paths.length; i += 1) {
    const relPath = scan.paths[i];
    if (relPath === undefined) continue;
    const { card, rawEdges: fileEdges } = await extractCard(absRoot, relPath);
    files.set(relPath, card);
    if (fileEdges.length > 0) rawEdges.set(relPath, fileEdges);
    onProgress?.({ phase: "extract", done: i + 1, total: scan.paths.length } satisfies ProgressEvent);
  }
  onProgress?.({ phase: "resolve", done: 0, total: 0 } satisfies ProgressEvent);
  const index = finalizeIndex(absRoot, files, rawEdges);
  const cacheDir = resolveCacheDir(options?.cacheDir);
  onProgress?.({ phase: "save", done: 0, total: 0 } satisfies ProgressEvent);
  await saveArtifact(index, cacheDir);
  return index;
}
