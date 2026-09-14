import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import type {
  CardLanguage,
  EdgeKind,
  FileCard,
  OsnovaEdge,
  OsnovaIndex,
  SourceSpan,
  SymbolKind,
  IndexDiagnostic,
} from "../types.js";
import { indexFormatVersion } from "../types.js";
import { OsnovaIndexImpl } from "./indexImpl.js";
import { workspaceDirFor, evictLru } from "../cache/cache.js";
import { IndexingError } from "./diagnostics.js";

const GZIP_THRESHOLD_BYTES = 4 * 1024 * 1024;

class ArtifactVersionError extends Error {
  constructor(readonly version: unknown) {
    super(`osnova: index artifact format version ${String(version)} != ${indexFormatVersion}; rebuild the index`);
  }
}

interface SerializedSpan {
  readonly s: number;
  readonly e: number;
  readonly sc: number;
  readonly ec: number;
}

interface SerializedSymbol {
  readonly name: string;
  readonly q: string;
  readonly kind: SymbolKind;
  readonly span: SerializedSpan;
  readonly signature: string;
}

interface SerializedFile {
  readonly path: string;
  readonly language: CardLanguage;
  readonly hash: string;
  readonly size: number;
  readonly lineCount: number;
  readonly text: string;
  readonly symbols: readonly SerializedSymbol[];
  readonly diagnostics: readonly IndexDiagnostic[];
}

interface SerializedEdge {
  readonly k: EdgeKind;
  readonly f: string;
  readonly fs: string;
  readonly t: string;
  readonly l: number;
  readonly ts?: string | undefined;
  readonly tf?: string | undefined;
}

interface SerializedArtifact {
  readonly formatVersion: number;
  readonly root: string;
  readonly files: readonly SerializedFile[];
  readonly edges: readonly SerializedEdge[];
}

export function serializeArtifact(index: OsnovaIndex): Buffer {
  const files: SerializedFile[] = [];
  for (const card of [...index.files.values()].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    files.push({
      path: card.path,
      language: card.language,
      hash: card.hash,
      size: card.size,
      lineCount: card.lineCount,
      text: card.text,
      symbols: card.symbols.map((symbol) => ({
        name: symbol.name,
        q: symbol.qualifiedName,
        kind: symbol.kind,
        span: {
          s: symbol.span.startLine,
          e: symbol.span.endLine,
          sc: symbol.span.startCol,
          ec: symbol.span.endCol,
        },
        signature: symbol.signature,
      })),
      diagnostics: card.diagnostics ?? [],
    });
  }
  const edges: SerializedEdge[] = index.edges.map((edge) => {
    const base = {
      k: edge.kind,
      f: edge.fromFile,
      fs: edge.fromSymbol,
      t: edge.toName,
      l: edge.line,
    };
    if (edge.toFile !== undefined) {
      return { ...base, ts: edge.toSymbol, tf: edge.toFile };
    }
    if (edge.toSymbol !== undefined) {
      return { ...base, ts: edge.toSymbol };
    }
    return base;
  });
  const artifact: SerializedArtifact = {
    formatVersion: indexFormatVersion,
    root: index.root,
    files,
    edges,
  };
  return Buffer.from(JSON.stringify(artifact), "utf8");
}

export function deserializeArtifact(data: string): OsnovaIndexImpl {
  const parsed: unknown = JSON.parse(data);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("osnova: corrupt index artifact");
  }
  const artifact = parsed as SerializedArtifact;
  if (artifact.formatVersion !== indexFormatVersion) {
    throw new ArtifactVersionError(artifact.formatVersion);
  }
  const files = new Map<string, FileCard>();
  for (const file of artifact.files) {
    if (!Array.isArray(file.diagnostics) || file.diagnostics.some((diagnostic: unknown) => {
      if (typeof diagnostic !== "object" || diagnostic === null) return true;
      const value = diagnostic as Partial<IndexDiagnostic>;
      return typeof value.path !== "string" || typeof value.code !== "string" ||
        !["scan", "read", "parse", "cache"].includes(value.phase ?? "");
    })) {
      throw new Error("osnova: corrupt index diagnostic metadata");
    }
    const symbols = file.symbols.map((symbol) => {
      const span: SourceSpan = {
        startLine: symbol.span.s,
        endLine: symbol.span.e,
        startCol: symbol.span.sc,
        endCol: symbol.span.ec,
      };
      return {
        name: symbol.name,
        qualifiedName: symbol.q,
        kind: symbol.kind,
        file: file.path,
        span,
        signature: symbol.signature,
        lineCount: Math.max(1, span.endLine - span.startLine + 1),
      };
    });
    files.set(file.path, {
      path: file.path,
      language: file.language,
      hash: file.hash,
      size: file.size,
      lineCount: file.lineCount,
      text: file.text,
      symbols,
      diagnostics: file.diagnostics,
    });
  }
  const edges: OsnovaEdge[] = artifact.edges.map((edge) =>
    edge.tf !== undefined
      ? { kind: edge.k, fromFile: edge.f, fromSymbol: edge.fs, toName: edge.t, line: edge.l, toSymbol: edge.ts, toFile: edge.tf }
      : edge.ts !== undefined
        ? { kind: edge.k, fromFile: edge.f, fromSymbol: edge.fs, toName: edge.t, line: edge.l, toSymbol: edge.ts }
        : { kind: edge.k, fromFile: edge.f, fromSymbol: edge.fs, toName: edge.t, line: edge.l },
  );
  return new OsnovaIndexImpl(artifact.root, files, edges);
}

export async function saveArtifact(index: OsnovaIndex, cacheDir: string): Promise<string> {
  const dir = workspaceDirFor(cacheDir, index.root);
  let tmpPath: string | undefined;
  try {
    await fs.mkdir(dir, { recursive: true });
    const raw = serializeArtifact(index);
    const gzipped = raw.length > GZIP_THRESHOLD_BYTES;
    const finalPath = path.join(dir, gzipped ? "index.json.gz" : "index.json");
    tmpPath = `${finalPath}.tmp-${process.pid}-${randomUUID()}`;
    const payload = gzipped ? gzipSync(raw) : raw;
    await fs.writeFile(tmpPath, payload);
    await fs.rename(tmpPath, finalPath);
    const other = path.join(dir, gzipped ? "index.json" : "index.json.gz");
    await fs.rm(other, { force: true }).catch(() => {});
    await evictLru(cacheDir).catch(() => {});
    return finalPath;
  } catch (error) {
    throw new IndexingError({ phase: "cache", path: dir, code: "cache-write-failed" }, error);
  } finally {
    if (tmpPath !== undefined) await fs.rm(tmpPath, { force: true }).catch(() => {});
  }
}

export async function loadArtifact(root: string, cacheDir: string): Promise<OsnovaIndexImpl | undefined> {
  const dir = workspaceDirFor(cacheDir, root);
  for (const name of ["index.json.gz", "index.json"]) {
    try {
      const data = await fs.readFile(path.join(dir, name));
      const content = name.endsWith(".gz") ? gunzipSync(data).toString("utf8") : data.toString("utf8");
      return deserializeArtifact(content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (error instanceof ArtifactVersionError && error.version === 1) return undefined;
      throw new IndexingError({ phase: "cache", path: dir, code: "cache-read-failed" }, error);
    }
  }
  return undefined;
}

export async function artifactPathFor(root: string, cacheDir: string): Promise<string | undefined> {
  const dir = workspaceDirFor(cacheDir, root);
  for (const name of ["index.json.gz", "index.json"]) {
    try {
      await fs.access(path.join(dir, name));
      return path.join(dir, name);
    } catch {
      continue;
    }
  }
  return undefined;
}
