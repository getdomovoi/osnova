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
  EdgeEvidence,
  EdgeResolution,
  EdgeBinding,
  ReExport,
  MemberKind,
} from "../types.js";
import { indexFormatVersion } from "../types.js";
import { OsnovaIndexImpl } from "./indexImpl.js";
import { workspaceDirFor, workspaceLockPath, evictLru, touchWorkspace, cacheLimits } from "../cache/cache.js";
import type { CachePolicy } from "../cache/cache.js";
import { withCacheLock } from "../cache/lock.js";
import { IndexingError } from "./diagnostics.js";
import { rememberIndexGeneration } from "./generation.js";
import { bindIndexCache, validRelativePath, workspaceIdentity } from "./workspace.js";
import { sha256Hex } from "./scan.js";

const GZIP_THRESHOLD_BYTES = 4 * 1024 * 1024;
export const extractionVersion = "structural-7.scan-3.tree-sitter-0.25.10.grammars-0.1.13";
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

class ExtractionVersionError extends Error {}

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
  readonly exportedNames: readonly string[];
  readonly memberKind?: MemberKind | undefined;
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
  readonly reExports: readonly ReExport[];
}

interface SerializedEdge {
  readonly k: EdgeKind;
  readonly f: string;
  readonly fs: string;
  readonly t: string;
  readonly l: number;
  readonly ts?: string | undefined;
  readonly tf?: string | undefined;
  readonly e: EdgeEvidence;
  readonly b?: EdgeBinding | undefined;
}

interface SerializedArtifact {
  readonly formatVersion: number;
  readonly extractionVersion: string;
  readonly checksum: string;
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
        exportedNames: symbol.exportedNames ?? [],
        ...(symbol.memberKind === undefined ? {} : { memberKind: symbol.memberKind }),
      })),
      diagnostics: card.diagnostics ?? [],
      reExports: card.reExports ?? [],
    });
  }
  const edges: SerializedEdge[] = index.edges.map((edge) => {
    const base = {
      k: edge.kind,
      f: edge.fromFile,
      fs: edge.fromSymbol,
      t: edge.toName,
      l: edge.line,
      e: edge.evidence ?? { source: "unknown" as const },
      ...(edge.binding === undefined ? {} : { b: edge.binding }),
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
    extractionVersion,
    checksum: sha256Hex(JSON.stringify({ root: index.root, files, edges })),
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
  if (artifact.extractionVersion !== extractionVersion) {
    throw new ExtractionVersionError("osnova: extraction inputs changed; rebuild the index");
  }
  if (typeof artifact.root !== "string" || !path.isAbsolute(artifact.root) || path.normalize(artifact.root) !== artifact.root ||
    !Array.isArray(artifact.files) || !Array.isArray(artifact.edges)) throw new Error("osnova: corrupt index envelope");
  const files = new Map<string, FileCard>();
  for (const file of artifact.files) {
    if (typeof file !== "object" || file === null || !validRelativePath(file.path) || files.has(file.path) ||
      !["typescript", "tsx", "javascript", "python", "go", "rust", "java", "c_sharp", "fallback"].includes(file.language) ||
      typeof file.hash !== "string" || !/^[a-f0-9]{64}$/.test(file.hash) ||
      !nonnegativeInteger(file.size) || !nonnegativeInteger(file.lineCount) || typeof file.text !== "string" ||
      !Array.isArray(file.symbols)) throw new Error("osnova: corrupt file metadata");
    const binaryCard = file.language === "fallback" && file.text === "" && file.size > 0;
    if (!binaryCard && (Buffer.byteLength(file.text) !== file.size || sha256Hex(file.text) !== file.hash ||
      (file.text.length === 0 ? 0 : file.text.split("\n").length) !== file.lineCount)) throw new Error("osnova: corrupt file content");
    if (binaryCard && (file.lineCount !== 0 || file.symbols.length !== 0)) throw new Error("osnova: corrupt binary card");
    if (!Array.isArray(file.reExports)) throw new Error("osnova: corrupt re-export metadata");
    const reExports = file.reExports.map(readReExport);
    if (!Array.isArray(file.diagnostics) || file.diagnostics.some((diagnostic: unknown) => {
      if (typeof diagnostic !== "object" || diagnostic === null) return true;
      const value = diagnostic as Partial<IndexDiagnostic>;
      return typeof value.path !== "string" || typeof value.code !== "string" ||
        !["scan", "read", "parse", "cache"].includes(value.phase ?? "");
    })) {
      throw new Error("osnova: corrupt index diagnostic metadata");
    }
    const symbols = file.symbols.map((symbol: SerializedSymbol) => {
      if (typeof symbol !== "object" || symbol === null || typeof symbol.name !== "string" ||
        typeof symbol.q !== "string" || !symbol.q.startsWith(`${file.path}#`) || typeof symbol.signature !== "string" ||
        !["function", "method", "class", "struct", "interface", "trait", "enum", "type", "constant"].includes(symbol.kind) ||
        typeof symbol.span !== "object" || symbol.span === null || !positiveInteger(symbol.span.s) ||
        !positiveInteger(symbol.span.e) || symbol.span.e < symbol.span.s || symbol.span.e > file.lineCount ||
        !nonnegativeInteger(symbol.span.sc) || !nonnegativeInteger(symbol.span.ec) ||
        (symbol.span.s === symbol.span.e && symbol.span.ec < symbol.span.sc)) throw new Error("osnova: corrupt symbol metadata");
      if (!Array.isArray(symbol.exportedNames) || !symbol.exportedNames.every((name: unknown) => typeof name === "string")) {
        throw new Error("osnova: corrupt exported-name metadata");
      }
      if (symbol.memberKind !== undefined && !["instance", "static", "class", "property", "unknown"].includes(symbol.memberKind)) throw new Error("osnova: corrupt member-kind metadata");
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
        exportedNames: symbol.exportedNames,
        ...(symbol.memberKind === undefined ? {} : { memberKind: symbol.memberKind }),
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
      reExports,
    });
  }
  const edges: OsnovaEdge[] = artifact.edges.map((edge) => {
    if (typeof edge !== "object" || edge === null || !["calls", "references", "imports"].includes(edge.k) ||
      !files.has(edge.f) || typeof edge.fs !== "string" || (edge.fs !== "" && edge.fs !== edge.f && !edge.fs.startsWith(`${edge.f}#`)) ||
      typeof edge.t !== "string" || !positiveInteger(edge.l) || edge.l > (files.get(edge.f)?.lineCount ?? 0) ||
      (edge.tf !== undefined && (!validRelativePath(edge.tf) || !files.has(edge.tf))) ||
      (edge.ts !== undefined && typeof edge.ts !== "string")) throw new Error("osnova: corrupt edge metadata");
    const evidence = readEvidence(edge.e);
    return {
      kind: edge.k, fromFile: edge.f, fromSymbol: edge.fs, toName: edge.t, line: edge.l, evidence,
      ...(edge.ts !== undefined ? { toSymbol: edge.ts } : {}),
      ...(edge.tf !== undefined ? { toFile: edge.tf } : {}),
      ...(edge.b === undefined ? {} : { binding: readBinding(edge.b) }),
    };
  });
  if (artifact.checksum !== sha256Hex(JSON.stringify({ root: artifact.root, files: artifact.files, edges: artifact.edges }))) {
    throw new Error("osnova: corrupt artifact checksum");
  }
  const index = new OsnovaIndexImpl(artifact.root, files, edges);
  rememberIndexGeneration(index, data);
  return index;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return nonnegativeInteger(value) && value > 0;
}

function readEvidence(value: unknown): EdgeEvidence {
  if (typeof value === "object" && value !== null) {
    const evidence = value as { source?: unknown; resolution?: unknown };
    if (evidence.source === "unknown") return { source: "unknown" };
    if (evidence.source === "syntax" && typeof evidence.resolution === "object" && evidence.resolution !== null) {
      const resolution = evidence.resolution as Partial<EdgeResolution>;
      if (resolution.status === "resolved" && ["import-path", "same-file-name", "imported-file-name", "unique-name", "import-binding", "lexical-definition"].includes(resolution.method ?? "")) {
        return value as EdgeEvidence;
      }
      if (resolution.status === "resolved" && resolution.method === "re-export-binding" && validHops(resolution.via)) return value as EdgeEvidence;
      if (resolution.status === "resolved" && resolution.method === "receiver-hint" &&
        typeof resolution.receiver === "object" && resolution.receiver !== null &&
        typeof resolution.receiver.classSymbol === "string" && ["class", "instance"].includes(resolution.receiver.mode) &&
        ["constructor", "lexical", "class-reference"].includes(resolution.receiver.basis) &&
        (resolution.via === undefined || validHops(resolution.via))) return value as EdgeEvidence;
      if (resolution.status === "ambiguous" && Array.isArray(resolution.candidates) &&
        resolution.candidates.length > 1 && resolution.candidates.every((candidate: unknown) => typeof candidate === "string")) {
        return value as EdgeEvidence;
      }
      if (resolution.status === "unresolved" && ["no-matching-symbol", "import-target-unresolved", "binding-blocked", "bound-symbol-missing", "re-export-incomplete", "re-export-cycle", "receiver-unresolved"].includes(resolution.reason ?? "")) {
        return value as EdgeEvidence;
      }
    }
  }
  throw new Error("osnova: corrupt edge evidence metadata");
}

function validHops(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.length <= 128 && value.every((hop: unknown) => {
    if (typeof hop !== "object" || hop === null) return false;
    const item = hop as Record<string, unknown>;
    return ["file", "source", "exportedName", "importedName", "targetFile"].every((key) => typeof item[key] === "string") &&
      (item.kind === "named" || item.kind === "star") && Number.isSafeInteger(item.line) && (item.line as number) > 0;
  });
}

function validSymbolBinding(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const binding = value as Record<string, unknown>;
  return (binding.kind === "local" && typeof binding.name === "string") ||
    (binding.kind === "import" && typeof binding.source === "string" && typeof binding.importedName === "string");
}

function readReExport(value: unknown): ReExport {
  if (typeof value === "object" && value !== null) {
    const link = value as Partial<ReExport>;
    if (Number.isSafeInteger(link.line) && (link.line ?? 0) > 0) {
      if (link.kind === "star" && typeof link.source === "string") return value as ReExport;
      if (link.kind === "blocked" && typeof link.exportedName === "string") return value as ReExport;
      if (link.kind === "named" && typeof link.exportedName === "string" && typeof link.source === "string" && typeof link.importedName === "string") return value as ReExport;
    }
  }
  throw new Error("osnova: corrupt re-export metadata");
}

function readBinding(value: unknown): EdgeBinding {
  if (typeof value === "object" && value !== null) {
    const binding = value as Partial<EdgeBinding>;
    if (binding.kind === "import" && typeof binding.source === "string" && typeof binding.importedName === "string") return value as EdgeBinding;
    if (binding.kind === "local" && typeof binding.name === "string") return value as EdgeBinding;
    if (binding.kind === "blocked" && ["local-value", "unsupported", "ambiguous", "unknown-receiver"].includes(binding.reason ?? "")) return value as EdgeBinding;
    if (binding.kind === "instance" && validSymbolBinding(binding.owner) && ["constructor", "lexical"].includes(binding.basis ?? "")) return value as EdgeBinding;
    if (binding.kind === "member" && validSymbolBinding(binding.owner) && typeof binding.member === "string" &&
      ["instance", "class"].includes(binding.mode ?? "") && ["constructor", "lexical", "class-reference"].includes(binding.basis ?? "")) return value as EdgeBinding;
  }
  throw new Error("osnova: corrupt binding metadata");
}

export async function saveArtifact(index: OsnovaIndex, cacheDir: string, policy: CachePolicy = {}): Promise<string> {
  return withCacheLock(workspaceLockPath(cacheDir, index.root), async () => {
    const dir = workspaceDirFor(cacheDir, index.root);
    let tmpPath: string | undefined;
    try {
      await fs.mkdir(dir, { recursive: true });
      if ((await fs.lstat(dir)).isSymbolicLink()) throw new Error("cache workspace must not be a symlink");
    const raw = serializeArtifact(index);
    rememberIndexGeneration(index, raw);
      const gzipped = raw.length > GZIP_THRESHOLD_BYTES;
      const finalPath = path.join(dir, "index.json");
      tmpPath = `${finalPath}.tmp-${process.pid}-${randomUUID()}`;
      const payload = gzipped ? gzipSync(raw, { level: 1 }) : raw;
      const limits = cacheLimits(policy);
      if (payload.length > limits.maxBytes || limits.maxWorkspaces === 0 || raw.length > MAX_ARTIFACT_BYTES) {
        throw new Error("osnova: artifact exceeds configured cache limits");
      }
      await fs.writeFile(tmpPath, payload, { flag: "wx" });
      await fs.rename(tmpPath, finalPath);
      await fs.rm(path.join(dir, "index.json.gz"), { force: true });
      await touchWorkspace(dir);
      await evictLru(cacheDir, policy);
      return finalPath;
    } catch (error) {
      throw new IndexingError({ phase: "cache", path: dir, code: "cache-write-failed" }, error);
    } finally {
      if (tmpPath !== undefined) await fs.rm(tmpPath, { force: true }).catch(() => {});
    }
  });
}

export async function loadArtifact(root: string, cacheDir: string): Promise<OsnovaIndexImpl | undefined> {
  root = workspaceIdentity(root);
  return withCacheLock(workspaceLockPath(cacheDir, root), async () => {
    const dir = workspaceDirFor(cacheDir, root);
    for (const name of ["index.json", "index.json.gz"]) {
      try {
        if ((await fs.lstat(dir)).isSymbolicLink()) throw new Error("cache workspace must not be a symlink");
        const artifactPath = path.join(dir, name);
        const stat = await fs.lstat(artifactPath);
        if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) throw new Error("invalid cache artifact file");
        const data = await fs.readFile(artifactPath);
        const content = data[0] === 0x1f && data[1] === 0x8b
          ? gunzipSync(data, { maxOutputLength: MAX_ARTIFACT_BYTES }).toString("utf8") : data.toString("utf8");
        const index = deserializeArtifact(content);
        if (index.root !== root) throw new Error("osnova: cache artifact belongs to a different workspace");
        for (const card of index.files.values()) {
          if (!/^[a-f0-9]{64}$/.test(card.hash) || card.lineCount !== (card.text.length === 0 ? 0 : card.text.split("\n").length) ||
            (Buffer.byteLength(card.text) === card.size && sha256Hex(card.text) !== card.hash)) {
            throw new Error("osnova: corrupt cached source content");
          }
        }
        await touchWorkspace(dir).catch((error: unknown) => {
          throw new IndexingError({ phase: "cache", path: dir, code: "cache-access-write-failed" }, error);
        });
        return bindIndexCache(index, cacheDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        if (error instanceof ArtifactVersionError && typeof error.version === "number" &&
          Number.isInteger(error.version) && error.version > 0 && error.version < indexFormatVersion) return undefined;
        if (error instanceof ExtractionVersionError) return undefined;
        throw new IndexingError({ phase: "cache", path: dir, code: "cache-read-failed" }, error);
      }
    }
    return undefined;
  });
}

export async function artifactPathFor(root: string, cacheDir: string): Promise<string | undefined> {
  const dir = workspaceDirFor(cacheDir, root);
  for (const name of ["index.json", "index.json.gz"]) {
    try {
      await fs.access(path.join(dir, name));
      return path.join(dir, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return undefined;
}
