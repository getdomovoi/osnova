import { promises as fs } from "node:fs";
import { discardParser, getParser } from "../grammar/loader.js";
import { languageForPath } from "../grammar/languages.js";
import { adapterFor } from "../extract/adapters.js";
import { forgetTree, localJoin } from "../extract/util.js";
import type { RawDefinition, RawEdge } from "../extract/adapter.js";
import type {
  CardLanguage,
  FileCard,
  OsnovaIndex,
  OsnovaSymbol,
  ProgressEvent,
  IndexDiagnostic,
  ReExport,
} from "../types.js";
import { OsnovaIndexImpl, qualifiedNameOf } from "./indexImpl.js";
import type { RawEdgeItem } from "./indexImpl.js";
import { resolveCacheDir, workspaceLockPath } from "../cache/cache.js";
import { withCacheLock } from "../cache/lock.js";
import { artifactPathFor, saveArtifact, serializeArtifact } from "./serialize.js";
import { ensureFamilySidecar, seedProgress, seedWorkspace } from "./seed.js";
import { saveVerification } from "./verification.js";
import { knownIndexGeneration } from "./generation.js";
import { resolveEdges } from "./resolve.js";
import type { EdgeReuse } from "./resolve.js";
import { scanFiles, sha256Hex, sourceText } from "./scan.js";
import { IndexingError } from "./diagnostics.js";
import { bindIndexCache, canonicalWorkspaceRoot, workspaceFilePath } from "./workspace.js";
import type { WorkspaceOptions } from "./workspace.js";
import { applyFreshnessReport, inspectFreshness, isStale } from "./incremental.js";
import { extractCards } from "./extractPool.js";

function languageOf(relPath: string): CardLanguage {
  return languageForPath(relPath) ?? "fallback";
}

export async function extractCard(
  absRoot: string,
  relPath: string,
): Promise<{ card: FileCard; rawEdges: RawEdgeItem[] }> {
  const abs = await workspaceFilePath(absRoot, relPath);
  const buffer = await fs.readFile(abs).catch((error: unknown) => {
    throw new IndexingError({ phase: "read", path: relPath, code: "file-unreadable" }, error);
  });
  const hash = sha256Hex(buffer);
  const language = languageOf(relPath);
  const decoded = sourceText(buffer);
  const binary = decoded === null;
  const text = decoded ?? "";
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
      diagnostics: [],
      reExports: [],
    };
    return { card, rawEdges: [] };
  }

  let definitions: RawDefinition[] = [];
  let rawEdges: RawEdgeItem[] = [];
  let reExports: readonly ReExport[] = [];
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
        reExports = output.reExports ?? [];
        rawEdges = output.edges.map((edge: RawEdge) => ({
          kind: edge.kind,
          toName: edge.toName,
          line: edge.line,
          enclosing: edge.enclosing,
          ...(edge.binding === undefined ? {} : { binding: edge.binding }),
        }));
      } finally {
        tree.delete();
        forgetTree(tree);
      }
    } else {
      diagnostics.push({ phase: "parse", path: relPath, code: "empty-parse" });
    }
  } catch {
    discardParser(language);
    definitions = [];
    rawEdges = [];
    reExports = [];
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
      ...(def.exportedNames === undefined ? {} : { exportedNames: def.exportedNames }),
      ...(def.memberKind === undefined ? {} : { memberKind: def.memberKind }),
      ...(def.heritage === undefined ? {} : { heritage: def.heritage }),
      ...(def.fields === undefined ? {} : { fields: def.fields }),
      ...(def.returns === undefined ? {} : { returns: def.returns }),
      ...(def.returnTuple === undefined ? {} : { returnTuple: def.returnTuple }),
      ...(def.aliasOf === undefined ? {} : { aliasOf: def.aliasOf }),
      ...(def.fieldTypes === undefined ? {} : { fieldTypes: def.fieldTypes }),
      ...(def.unwrapped === undefined ? {} : { unwrapped: def.unwrapped }),
      ...(def.elements === undefined ? {} : { elements: def.elements }),
      ...(def.elementTypes === undefined ? {} : { elementTypes: def.elementTypes }),
      ...(def.values === undefined ? {} : { values: def.values }),
      ...(def.valueTypes === undefined ? {} : { valueTypes: def.valueTypes }),
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
    reExports,
  };
  return { card, rawEdges };
}

export function finalizeIndex(
  root: string,
  files: Map<string, FileCard>,
  rawEdges: ReadonlyMap<string, readonly RawEdgeItem[]>,
  reuse?: EdgeReuse,
): OsnovaIndexImpl {
  const edges = resolveEdges({ root, files, rawEdges, ...(reuse === undefined ? {} : { reuse }) });
  return new OsnovaIndexImpl(root, files, edges);
}

export async function buildIndex(root: string, options?: WorkspaceOptions): Promise<OsnovaIndex> {
  const absRoot = await canonicalWorkspaceRoot(root);
  const cacheDir = resolveCacheDir(options?.cacheDir);
  await fs.mkdir(cacheDir, { recursive: true });
  const canonicalCache = await fs.realpath(cacheDir);
  return withCacheLock(workspaceLockPath(canonicalCache, absRoot), async () => {
    const seed = await artifactPathFor(absRoot, canonicalCache) === undefined
      ? await seedWorkspace(absRoot, canonicalCache, options)
      : undefined;
    let seeded = seed?.index !== undefined && seed.sibling !== undefined ? { index: seed.index, sibling: seed.sibling } : undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let index = seeded?.index ?? await buildIndexSnapshot(absRoot, options?.onProgress, canonicalCache);
      let inspection = await inspectFreshness(index, absRoot);
      if (seeded !== undefined) {
        options?.onProgress?.(seedProgress(seeded.sibling, index.files.size, inspection.report));
        seeded = undefined;
        if (isStale(inspection.report)) {
          index = await applyFreshnessReport(index, absRoot, [], inspection.report);
          inspection = await inspectFreshness(index, absRoot, inspection.metadata);
        }
      }
      if (isStale(inspection.report)) continue;
      options?.onProgress?.({ phase: "save", done: 0, total: 0 });
      await saveArtifact(index, canonicalCache, options);
      await saveVerification(canonicalCache, absRoot, knownIndexGeneration(index) ?? sha256Hex(serializeArtifact(index)), inspection.metadata);
      await ensureFamilySidecar(canonicalCache, absRoot, seed?.family, seed !== undefined);
      return index;
    }
    throw new IndexingError({ phase: "scan", path: absRoot, code: "workspace-changing" });
  }, options);
}

export async function buildIndexSnapshot(absRoot: string, onProgress?: WorkspaceOptions["onProgress"], cacheDir?: string): Promise<OsnovaIndex> {
  onProgress?.({ phase: "scan", done: 0, total: 0 } satisfies ProgressEvent);
  const scan = await scanFiles(absRoot, cacheDir);
  const files = new Map<string, FileCard>();
  const rawEdges = new Map<string, RawEdgeItem[]>();
  const extracted = await extractCards(absRoot, scan.paths, extractCard, (done) => {
    onProgress?.({ phase: "extract", done, total: scan.paths.length } satisfies ProgressEvent);
  });
  for (const { card, rawEdges: fileEdges } of extracted) {
    files.set(card.path, card);
    if (fileEdges.length > 0) rawEdges.set(card.path, fileEdges);
  }
  onProgress?.({ phase: "resolve", done: 0, total: 0 } satisfies ProgressEvent);
  return bindIndexCache(finalizeIndex(absRoot, files, rawEdges), cacheDir);
}
