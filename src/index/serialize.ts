import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import type {
  CardLanguage,
  FileCard,
  OsnovaEdge,
  OsnovaIndex,
  SourceSpan,
  ReturnBinding,
  SymbolBinding,
  SymbolKind,
  IndexDiagnostic,
  ReExport,
  MemberKind,
  Callee,
  RouteSite,
  SymbolDegree,
  OsnovaSymbol,
} from "../types.js";
import { indexFormatVersion } from "../types.js";
import { membersOf, validOwner } from "./edgeStore.js";
import { OsnovaIndexImpl } from "./indexImpl.js";
import type { EdgeSource } from "./indexImpl.js";
import { serializeEdges, deserializeEdges } from "./edgeStore.js";
import type { EdgeLayout } from "./edgeStore.js";
import { workspaceDirFor, workspaceLockPath, evictLru, touchWorkspace, cacheLimits, recordReader } from "../cache/cache.js";
import type { CachePolicy } from "../cache/cache.js";
import { cacheLockTimeoutIn, withCacheLock } from "../cache/lock.js";
import type { LockOptions } from "../cache/lock.js";
import { IndexingError, SectionError } from "./diagnostics.js";
import { bindIndexGeneration, rememberIndexGeneration } from "./generation.js";
import { bindIndexCache, validRelativePath, workspaceIdentity } from "./workspace.js";
import { sha256Hex } from "./scan.js";
import { loadVerification } from "./verification.js";
import { lazyTextCard, previousTextFrom, rebindPublishedText, serializeText } from "./textStore.js";
import type { PreviousText, TextLayout } from "./textStore.js";
import { grammarFile } from "../grammar/languages.js";
import { queriesFingerprint } from "../grammar/queries/index.js";

const GZIP_THRESHOLD_BYTES = 4 * 1024 * 1024;
export const extractionVersion = `structural-9.30.scan-4.tree-sitter-0.25.10.grammars-0.1.13.queries-${queriesFingerprint}`;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

const diagnosticPhases = membersOf<IndexDiagnostic["phase"]>({ scan: true, read: true, parse: true, cache: true });
const symbolKinds = membersOf<SymbolKind>({
  function: true, method: true, class: true, struct: true, interface: true, trait: true, enum: true, type: true, constant: true, module: true,
});
const memberKinds = membersOf<MemberKind>({ instance: true, static: true, class: true, property: true, unknown: true });

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
  readonly n: number;
  readonly q: string;
  readonly kind: SymbolKind;
  readonly span: SerializedSpan;
  readonly signature: string;
  readonly shadowed?: true | undefined;
  readonly exportedNames?: readonly string[] | undefined;
  readonly memberKind?: MemberKind | undefined;
  readonly heritage?: readonly SymbolBinding[] | undefined;
  readonly fields?: readonly string[] | undefined;
  readonly returns?: ReturnBinding | undefined;
  readonly returnTuple?: readonly (ReturnBinding | null)[] | undefined;
  readonly aliasOf?: Callee | undefined;
  readonly fieldTypes?: Readonly<Record<string, SymbolBinding>> | undefined;
  readonly unwrapped?: ReturnBinding | undefined;
  readonly elements?: ReturnBinding | undefined;
  readonly elementTypes?: Readonly<Record<string, SymbolBinding>> | undefined;
  readonly values?: ReturnBinding | undefined;
  readonly valueTypes?: Readonly<Record<string, SymbolBinding>> | undefined;
}

interface SerializedFile {
  readonly p: number;
  readonly language: CardLanguage;
  readonly hash: string;
  readonly size: number;
  readonly lineCount: number;
  readonly to: number;
  readonly tl: number;
  readonly symbols: readonly SerializedSymbol[];
  readonly diagnostics: readonly IndexDiagnostic[];
  readonly reExports: readonly ReExport[];
  readonly routes?: readonly RouteSite[] | undefined;
  readonly d: readonly number[];
}

interface SerializedArtifact {
  readonly formatVersion: number;
  readonly extractionVersion: string;
  readonly root: string;
  readonly paths: readonly string[];
  readonly names: readonly string[];
  readonly textHash: string;
  readonly textBytes: number;
  readonly edgesHash: string;
  readonly edgesBytes: number;
  readonly files: readonly SerializedFile[];
}

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function serializeSections(
  index: OsnovaIndex,
  previousText?: PreviousText | undefined,
): { core: Buffer; edges: EdgeLayout; text: TextLayout; paths: string[] } {
  const paths = [...index.files.keys()].sort(compareStr);
  const nameSet = new Set<string>();
  for (const card of index.files.values()) {
    for (const symbol of card.symbols) nameSet.add(symbol.name);
  }
  const names = [...nameSet].sort(compareStr);
  const nameIndex = new Map(names.map((n, i) => [n, i]));
  const text = serializeText(index, previousText);
  const edges = serializeEdges(index.edges, paths);
  const incomingCount = new Map<string, number>();
  const outgoingCount = new Map<string, number>();
  for (const edge of index.edges) {
    if (edge.toSymbol !== undefined) incomingCount.set(edge.toSymbol, (incomingCount.get(edge.toSymbol) ?? 0) + 1);
    if (edge.fromSymbol.length > 0) outgoingCount.set(edge.fromSymbol, (outgoingCount.get(edge.fromSymbol) ?? 0) + 1);
  }
  const files: SerializedFile[] = paths.map((p, i) => {
    const card = index.files.get(p)!;
    const [to, tl] = text.offsets.get(p)!;
    return {
      p: i,
      language: card.language,
      hash: card.hash,
      size: card.size,
      lineCount: card.lineCount,
      to,
      tl,
      symbols: card.symbols.map((symbol) => ({
        n: nameIndex.get(symbol.name)!,
        q: symbol.qualifiedName.slice(p.length + 1),
        kind: symbol.kind,
        span: {
          s: symbol.span.startLine,
          e: symbol.span.endLine,
          sc: symbol.span.startCol,
          ec: symbol.span.endCol,
        },
        signature: symbol.signature,
        ...(symbol.shadowed === undefined ? {} : { shadowed: symbol.shadowed }),
        ...(symbol.exportedNames === undefined ? {} : { exportedNames: symbol.exportedNames }),
        ...(symbol.memberKind === undefined ? {} : { memberKind: symbol.memberKind }),
        ...(symbol.heritage === undefined ? {} : { heritage: symbol.heritage }),
        ...(symbol.fields === undefined ? {} : { fields: symbol.fields }),
        ...(symbol.returns === undefined ? {} : { returns: symbol.returns }),
        ...(symbol.returnTuple === undefined ? {} : { returnTuple: symbol.returnTuple }),
        ...(symbol.aliasOf === undefined ? {} : { aliasOf: symbol.aliasOf }),
        ...(symbol.fieldTypes === undefined ? {} : { fieldTypes: symbol.fieldTypes }),
        ...(symbol.unwrapped === undefined ? {} : { unwrapped: symbol.unwrapped }),
        ...(symbol.elements === undefined ? {} : { elements: symbol.elements }),
        ...(symbol.elementTypes === undefined ? {} : { elementTypes: symbol.elementTypes }),
        ...(symbol.values === undefined ? {} : { values: symbol.values }),
        ...(symbol.valueTypes === undefined ? {} : { valueTypes: symbol.valueTypes }),
      })),
      diagnostics: card.diagnostics ?? [],
      reExports: card.reExports ?? [],
      ...(card.routes === undefined || card.routes.length === 0 ? {} : { routes: card.routes }),
      d: card.symbols.flatMap((symbol) => [incomingCount.get(symbol.qualifiedName) ?? 0, outgoingCount.get(symbol.qualifiedName) ?? 0]),
    };
  });
  const artifact: SerializedArtifact = {
    formatVersion: indexFormatVersion,
    extractionVersion,
    root: index.root,
    paths,
    names,
    textHash: text.hash,
    textBytes: text.bytes.length,
    edgesHash: edges.hash,
    edgesBytes: edges.bytes.length,
    files,
  };
  return { core: Buffer.from(JSON.stringify(artifact), "utf8"), edges, text, paths };
}

export function serializeArtifact(index: OsnovaIndex): Buffer {
  return serializeSections(index).core;
}

export function deserializeArtifact(
  data: string,
  textPath: string | undefined,
  textBytes?: Buffer,
  edgeBytes?: Buffer,
): OsnovaIndexImpl {
  return deserializeParsedArtifact(JSON.parse(data), data, textPath, undefined, textBytes, edgeBytes);
}

interface SerializedEnvelope {
  readonly formatVersion: number;
  readonly extractionVersion: string;
  readonly root: string;
  readonly textHash: string;
  readonly textBytes: number;
  readonly edgesHash: string;
  readonly edgesBytes: number;
}

function readEnvelope(parsed: unknown): SerializedEnvelope {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("osnova: corrupt index artifact");
  }
  const artifact = parsed as Partial<SerializedArtifact>;
  if (artifact.formatVersion !== indexFormatVersion) {
    throw new ArtifactVersionError(artifact.formatVersion);
  }
  if (artifact.extractionVersion !== extractionVersion) {
    throw new ExtractionVersionError("osnova: extraction inputs changed; rebuild the index");
  }
  if (typeof artifact.root !== "string" || !path.isAbsolute(artifact.root) || path.normalize(artifact.root) !== artifact.root) {
    throw new Error("osnova: corrupt index envelope");
  }
  if (typeof artifact.textHash !== "string" || !/^[a-f0-9]{64}$/.test(artifact.textHash) || !nonnegativeInteger(artifact.textBytes)) {
    throw new Error("osnova: corrupt text identity");
  }
  if (typeof artifact.edgesHash !== "string" || !/^[a-f0-9]{64}$/.test(artifact.edgesHash) || !nonnegativeInteger(artifact.edgesBytes)) {
    throw new Error("osnova: corrupt edge identity");
  }
  return {
    formatVersion: artifact.formatVersion, extractionVersion: artifact.extractionVersion, root: artifact.root,
    textHash: artifact.textHash, textBytes: artifact.textBytes, edgesHash: artifact.edgesHash, edgesBytes: artifact.edgesBytes,
  };
}

const FILES_KEY = Buffer.from(',"files":[', "utf8");

function envelopeOfCore(raw: Buffer): { envelope: SerializedEnvelope; parsed: unknown | undefined } {
  const cut = raw.indexOf(FILES_KEY);
  if (cut > 0) {
    let head: unknown;
    try {
      head = JSON.parse(`${raw.subarray(0, cut).toString("utf8")}}`);
    } catch {
      head = undefined;
    }
    if (typeof head === "object" && head !== null) return { envelope: readEnvelope(head), parsed: undefined };
  }
  const parsed: unknown = JSON.parse(raw.toString("utf8"));
  return { envelope: readEnvelope(parsed), parsed };
}

function deserializeParsedArtifact(
  parsed: unknown,
  data: string,
  textPath: string | undefined,
  edgeSource: { path: string; raw: Buffer } | undefined,
  textBytes?: Buffer,
  edgeBytes?: Buffer,
  rootOverride?: string,
): OsnovaIndexImpl {
  const body = deserializeBody(parsed, textPath, edgeSource, textBytes, edgeBytes);
  const index = new OsnovaIndexImpl(rootOverride ?? body.root, body.files, body.edges, body.degrees);
  if (rootOverride === undefined) rememberIndexGeneration(index, data);
  return index;
}

function deserializeBody(
  parsed: unknown,
  textPath: string | undefined,
  edgeSource: { path: string; raw: Buffer } | undefined,
  textBytes?: Buffer,
  edgeBytes?: Buffer,
): { root: string; files: Map<string, FileCard>; edges: readonly OsnovaEdge[] | EdgeSource; degrees: ReadonlyMap<string, SymbolDegree> } {
  const envelope = readEnvelope(parsed);
  const degrees = new Map<string, SymbolDegree>();
  const artifact = parsed as SerializedArtifact;
  if (!Array.isArray(artifact.files) || !Array.isArray(artifact.paths) || !Array.isArray(artifact.names)) {
    throw new Error("osnova: corrupt index envelope");
  }
  if (textBytes !== undefined && (textBytes.length !== artifact.textBytes || sha256Hex(textBytes) !== artifact.textHash)) {
    throw new Error("osnova: corrupt cached source content");
  }
  if (edgeBytes !== undefined && (edgeBytes.length !== artifact.edgesBytes || sha256Hex(edgeBytes) !== artifact.edgesHash)) {
    throw new Error("osnova: corrupt cached edge content");
  }
  const paths = artifact.paths;
  for (let i = 0; i < paths.length; i += 1) {
    if (typeof paths[i] !== "string" || !validRelativePath(paths[i])) throw new Error("osnova: corrupt path table");
    if (i > 0 && compareStr(paths[i - 1]!, paths[i]!) >= 0) throw new Error("osnova: corrupt path table");
  }
  const names = artifact.names;
  for (let i = 0; i < names.length; i += 1) {
    if (typeof names[i] !== "string") throw new Error("osnova: corrupt name table");
    if (i > 0 && compareStr(names[i - 1]!, names[i]!) >= 0) throw new Error("osnova: corrupt name table");
  }
  const files = new Map<string, FileCard>();
  for (let index = 0; index < artifact.files.length; index += 1) {
    const file = artifact.files[index];
    if (typeof file !== "object" || file === null || !integerIn(file.p, 0, paths.length - 1) || file.p !== index) {
      throw new Error("osnova: corrupt file metadata");
    }
    const filePath = paths[file.p]!;
    if (files.has(filePath) || !(Object.keys(grammarFile).includes(file.language) || file.language === "fallback") ||
      typeof file.hash !== "string" || !/^[a-f0-9]{64}$/.test(file.hash) ||
      !nonnegativeInteger(file.size) || !nonnegativeInteger(file.lineCount) ||
      !nonnegativeInteger(file.to) || !nonnegativeInteger(file.tl) || file.to + file.tl > artifact.textBytes ||
      !Array.isArray(file.symbols)) throw new Error("osnova: corrupt file metadata");
    if (!Array.isArray(file.d) || file.d.length !== 2 * file.symbols.length || !file.d.every(nonnegativeInteger)) throw new Error("osnova: corrupt degree table");
    const binaryCard = file.language === "fallback" && file.tl === 0 && file.size > 0;
    if (!binaryCard && file.tl !== file.size) throw new Error("osnova: corrupt file content");
    if (binaryCard && (file.lineCount !== 0 || file.symbols.length !== 0)) throw new Error("osnova: corrupt binary card");
    if (!Array.isArray(file.reExports)) throw new Error("osnova: corrupt re-export metadata");
    const reExports = file.reExports.map(readReExport);
    if (file.routes !== undefined && (!Array.isArray(file.routes) || file.routes.some((route: unknown) => {
      const value = route as Partial<RouteSite> | null;
      return typeof value !== "object" || value === null || typeof value.method !== "string" || !/^[A-Z]+$/.test(value.method) ||
        (value.path !== undefined && (typeof value.path !== "string" || value.path.length > 2048)) || !positiveInteger(value.line) || (value.line as number) > file.lineCount ||
        (value.handler !== undefined && typeof value.handler !== "string");
    }))) throw new Error("osnova: corrupt route metadata");
    const routes: RouteSite[] | undefined = file.routes === undefined ? undefined : file.routes.map((route: RouteSite) => ({ method: route.method, ...(route.path === undefined ? {} : { path: route.path }), line: route.line, ...(route.handler === undefined ? {} : { handler: route.handler }) }));
    if (!Array.isArray(file.diagnostics) || file.diagnostics.some((diagnostic: unknown) => {
      if (typeof diagnostic !== "object" || diagnostic === null) return true;
      const value = diagnostic as Partial<IndexDiagnostic>;
      return typeof value.path !== "string" || typeof value.code !== "string" ||
        !diagnosticPhases.has(value.phase ?? "");
    })) {
      throw new Error("osnova: corrupt index diagnostic metadata");
    }
    const symbols = file.symbols.map((symbol: SerializedSymbol) => {
      if (typeof symbol !== "object" || symbol === null || !integerIn(symbol.n, 0, names.length - 1) ||
        typeof symbol.q !== "string" || typeof symbol.signature !== "string" ||
        !symbolKinds.has(symbol.kind) ||
        typeof symbol.span !== "object" || symbol.span === null || !positiveInteger(symbol.span.s) ||
        !positiveInteger(symbol.span.e) || symbol.span.e < symbol.span.s || symbol.span.e > file.lineCount ||
        !nonnegativeInteger(symbol.span.sc) || !nonnegativeInteger(symbol.span.ec) ||
        (symbol.span.s === symbol.span.e && symbol.span.ec < symbol.span.sc)) throw new Error("osnova: corrupt symbol metadata");
      if (symbol.exportedNames !== undefined && (!Array.isArray(symbol.exportedNames) || !symbol.exportedNames.every((name: unknown) => typeof name === "string"))) {
        throw new Error("osnova: corrupt exported-name metadata");
      }
      if (symbol.shadowed !== undefined && symbol.shadowed !== true) throw new Error("osnova: corrupt shadowing metadata");
      if (symbol.memberKind !== undefined && !memberKinds.has(symbol.memberKind)) throw new Error("osnova: corrupt member-kind metadata");
      if (symbol.heritage !== undefined && (!Array.isArray(symbol.heritage) || !symbol.heritage.every((item: unknown) => typeof item === "object" && item !== null &&
        (((item as { kind?: unknown }).kind === "local" && typeof (item as { name?: unknown }).name === "string") ||
          ((item as { kind?: unknown }).kind === "import" && typeof (item as { source?: unknown }).source === "string" && typeof (item as { importedName?: unknown }).importedName === "string"))))) {
        throw new Error("osnova: corrupt heritage metadata");
      }
      if (symbol.fields !== undefined && (!Array.isArray(symbol.fields) || !symbol.fields.every((item: unknown) => typeof item === "string"))) throw new Error("osnova: corrupt field metadata");
      const validCallee = (item: unknown): boolean => { const value = item as { kind?: unknown; member?: unknown; mode?: unknown; owner?: unknown }; if (typeof value !== "object" || value === null) return false; if (value.kind === "local" || value.kind === "import") return validOwner(value); return value.kind === "method" && typeof value.member === "string" && (value.mode === undefined || value.mode === "instance" || value.mode === "class") && validOwner(value.owner); };
      const validReturn = (item: unknown): boolean => { const value = item as { kind?: unknown; name?: unknown; source?: unknown; importedName?: unknown }; return typeof value === "object" && value !== null && (value.kind === "this" || (value.kind === "local" && typeof value.name === "string") || (value.kind === "import" && typeof value.source === "string" && typeof value.importedName === "string")); };
      if (symbol.returns !== undefined && !validReturn(symbol.returns)) throw new Error("osnova: corrupt return metadata");
      if (symbol.unwrapped !== undefined && !validReturn(symbol.unwrapped)) throw new Error("osnova: corrupt return metadata");
      if (symbol.elements !== undefined && !validReturn(symbol.elements)) throw new Error("osnova: corrupt return metadata");
      if (symbol.values !== undefined && !validReturn(symbol.values)) throw new Error("osnova: corrupt return metadata");
      if (symbol.valueTypes !== undefined && (typeof symbol.valueTypes !== "object" || symbol.valueTypes === null || Array.isArray(symbol.valueTypes) || !Object.values(symbol.valueTypes as Record<string, unknown>).every((item) => validReturn(item) && (item as { kind: string }).kind !== "this"))) throw new Error("osnova: corrupt field metadata");
      if (symbol.elementTypes !== undefined && (typeof symbol.elementTypes !== "object" || symbol.elementTypes === null || Array.isArray(symbol.elementTypes) || !Object.values(symbol.elementTypes as Record<string, unknown>).every((item) => validReturn(item) && (item as { kind: string }).kind !== "this"))) throw new Error("osnova: corrupt field metadata");
      if (symbol.returnTuple !== undefined && (!Array.isArray(symbol.returnTuple) || !symbol.returnTuple.every((item: unknown) => item === null || validReturn(item)))) throw new Error("osnova: corrupt return metadata");
      if (symbol.aliasOf !== undefined && !validCallee(symbol.aliasOf)) throw new Error("osnova: corrupt alias metadata");
      if (symbol.fieldTypes !== undefined && (typeof symbol.fieldTypes !== "object" || symbol.fieldTypes === null || Array.isArray(symbol.fieldTypes) || !Object.values(symbol.fieldTypes as Record<string, unknown>).every((item) => validReturn(item) && (item as { kind: string }).kind !== "this"))) throw new Error("osnova: corrupt field metadata");
      const span: SourceSpan = {
        startLine: symbol.span.s,
        endLine: symbol.span.e,
        startCol: symbol.span.sc,
        endCol: symbol.span.ec,
      };
      return {
        name: names[symbol.n]!,
        qualifiedName: `${filePath}#${symbol.q}`,
        kind: symbol.kind,
        file: filePath,
        span,
        signature: symbol.signature,
        lineCount: Math.max(1, span.endLine - span.startLine + 1),
        ...(symbol.shadowed === undefined ? {} : { shadowed: symbol.shadowed }),
        ...(symbol.exportedNames === undefined ? {} : { exportedNames: symbol.exportedNames }),
        ...(symbol.memberKind === undefined ? {} : { memberKind: symbol.memberKind }),
        ...(symbol.heritage === undefined ? {} : { heritage: symbol.heritage }),
        ...(symbol.fields === undefined ? {} : { fields: symbol.fields }),
        ...(symbol.returns === undefined ? {} : { returns: symbol.returns }),
        ...(symbol.returnTuple === undefined ? {} : { returnTuple: symbol.returnTuple }),
        ...(symbol.aliasOf === undefined ? {} : { aliasOf: symbol.aliasOf }),
        ...(symbol.fieldTypes === undefined ? {} : { fieldTypes: symbol.fieldTypes }),
        ...(symbol.unwrapped === undefined ? {} : { unwrapped: symbol.unwrapped }),
        ...(symbol.elements === undefined ? {} : { elements: symbol.elements }),
        ...(symbol.elementTypes === undefined ? {} : { elementTypes: symbol.elementTypes }),
        ...(symbol.values === undefined ? {} : { values: symbol.values }),
        ...(symbol.valueTypes === undefined ? {} : { valueTypes: symbol.valueTypes }),
      };
    });
    symbols.forEach((symbol: OsnovaSymbol, i: number) => { degrees.set(symbol.qualifiedName, { incoming: file.d[2 * i]!, outgoing: file.d[2 * i + 1]! }); });
    const base = { path: filePath, language: file.language, hash: file.hash, size: file.size, lineCount: file.lineCount, symbols, diagnostics: file.diagnostics, reExports, ...(routes === undefined ? {} : { routes }) };
    if (textBytes !== undefined) {
      const text = textBytes.subarray(file.to, file.to + file.tl).toString("utf8");
      if (!binaryCard && (sha256Hex(text) !== file.hash || (text.length === 0 ? 0 : text.split("\n").length) !== file.lineCount)) throw new Error("osnova: corrupt file content");
      files.set(filePath, { ...base, text });
    } else if (textPath !== undefined) {
      files.set(filePath, lazyTextCard(base, textPath, file.to, file.tl, file.hash, artifact.textHash, artifact.textBytes));
    } else {
      throw new Error("osnova: text source required");
    }
  }
  let edges: readonly OsnovaEdge[] | EdgeSource;
  if (edgeBytes !== undefined) {
    edges = deserializeEdges(edgeBytes, paths, files);
  } else if (edgeSource !== undefined) {
    if (edgeSource.raw.length !== envelope.edgesBytes) throw new Error("osnova: corrupt cached edge content");
    edges = { path: edgeSource.path, raw: edgeSource.raw, paths };
  } else {
    throw new Error("osnova: edge source required");
  }
  return { root: envelope.root, files, edges, degrees };
}

export function serializedTextIdentity(data: string): { hash: string; bytes: number } {
  return textIdentityFromParsed(JSON.parse(data));
}

function textIdentityFromParsed(parsed: unknown): { hash: string; bytes: number } {
  const value = parsed as Partial<SerializedArtifact>;
  if (typeof value.textHash !== "string" || !nonnegativeInteger(value.textBytes)) throw new Error("osnova: corrupt text identity");
  return { hash: value.textHash, bytes: value.textBytes };
}

function legacyFormatVersion(raw: Buffer): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const version = (parsed as { formatVersion?: unknown }).formatVersion;
  return integerIn(version, 1, indexFormatVersion - 1) ? version : undefined;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return nonnegativeInteger(value) && value > 0;
}

function integerIn(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

function readReExport(value: unknown): ReExport {
  if (typeof value === "object" && value !== null) {
    const link = value as Partial<ReExport>;
    if (Number.isSafeInteger(link.line) && (link.line ?? 0) > 0) {
      if (link.kind === "star" && typeof link.source === "string") return value as ReExport;
      if (link.kind === "namespace" && typeof link.exportedName === "string" && typeof link.source === "string") return value as ReExport;
      if (link.kind === "blocked" && typeof link.exportedName === "string") return value as ReExport;
      if (link.kind === "named" && typeof link.exportedName === "string" && typeof link.source === "string" && typeof link.importedName === "string") return value as ReExport;
    }
  }
  throw new Error("osnova: corrupt re-export metadata");
}

export async function saveArtifact(index: OsnovaIndex, cacheDir: string, policy: CachePolicy = {}): Promise<string> {
  return withCacheLock(workspaceLockPath(cacheDir, index.root), async () => {
    const dir = workspaceDirFor(cacheDir, index.root);
    let tmpPath: string | undefined;
    let textTmp: string | undefined;
    let edgesTmp: string | undefined;
    let shaTmp: string | undefined;
    try {
      await fs.mkdir(dir, { recursive: true });
      if ((await fs.lstat(dir)).isSymbolicLink()) throw new Error("cache workspace must not be a symlink");
      const textFinal = path.join(dir, "text.bin");
      const previous = previousTextFrom(index);
      const { core: raw, edges, text: layout } = serializeSections(
        index,
        previous !== undefined && previous.path === textFinal ? previous : undefined,
      );
      rememberIndexGeneration(index, raw);
      textTmp = `${textFinal}.tmp-${process.pid}-${randomUUID()}`;
      const edgesFinal = path.join(dir, "edges.json");
      edgesTmp = `${edgesFinal}.tmp-${process.pid}-${randomUUID()}`;
      const edgesGzipped = edges.bytes.length > GZIP_THRESHOLD_BYTES;
      const edgesPayload = edgesGzipped ? gzipSync(edges.bytes, { level: 1 }) : edges.bytes;
      const gzipped = raw.length > GZIP_THRESHOLD_BYTES;
      const finalPath = path.join(dir, "index.json");
      tmpPath = `${finalPath}.tmp-${process.pid}-${randomUUID()}`;
      const payload = gzipped ? gzipSync(raw, { level: 1 }) : raw;
      const shaFinal = path.join(dir, "index.sha");
      shaTmp = `${shaFinal}.tmp-${process.pid}-${randomUUID()}`;
      const shaPayload = Buffer.from(`${sha256Hex(raw)}\n`, "utf8");
      const limits = cacheLimits(policy);
      if (payload.length + layout.bytes.length + edgesPayload.length + shaPayload.length > limits.maxBytes ||
        limits.maxWorkspaces === 0 || raw.length > MAX_ARTIFACT_BYTES) {
        throw new Error("osnova: artifact exceeds configured cache limits");
      }
      await fs.writeFile(textTmp, layout.bytes, { flag: "wx" });
      await fs.rename(textTmp, textFinal);
      textTmp = undefined;
      rebindPublishedText(index, textFinal, layout.offsets, layout.hash, layout.bytes.length);
      await fs.writeFile(edgesTmp, edgesPayload, { flag: "wx" });
      await fs.rename(edgesTmp, edgesFinal);
      edgesTmp = undefined;
      await fs.writeFile(tmpPath, payload, { flag: "wx" });
      await fs.rename(tmpPath, finalPath);
      tmpPath = undefined;
      await fs.writeFile(shaTmp, shaPayload, { flag: "wx" });
      await fs.rename(shaTmp, shaFinal);
      shaTmp = undefined;
      await fs.rm(path.join(dir, "index.json.gz"), { force: true });
      await touchWorkspace(dir);
      await evictLru(cacheDir, policy);
      return finalPath;
    } catch (error) {
      throw new IndexingError({ phase: "cache", path: dir, code: "cache-write-failed" }, error);
    } finally {
      if (tmpPath !== undefined) await fs.rm(tmpPath, { force: true }).catch(() => {});
      if (textTmp !== undefined) await fs.rm(textTmp, { force: true }).catch(() => {});
      if (edgesTmp !== undefined) await fs.rm(edgesTmp, { force: true }).catch(() => {});
      if (shaTmp !== undefined) await fs.rm(shaTmp, { force: true }).catch(() => {});
    }
  });
}

export async function loadArtifact(root: string, cacheDir: string): Promise<OsnovaIndexImpl | undefined> {
  root = workspaceIdentity(root);
  return withCacheLock(workspaceLockPath(cacheDir, root), async () => {
    const dir = workspaceDirFor(cacheDir, root);
    try {
      if ((await fs.lstat(dir)).isSymbolicLink()) throw new Error("cache workspace must not be a symlink");
      const corePath = path.join(dir, "index.json");
      const coreStat = await fs.lstat(corePath);
      if (!coreStat.isFile() || coreStat.size > MAX_ARTIFACT_BYTES) throw new Error("invalid cache artifact file");
      const data = await fs.readFile(corePath);
      const raw = data[0] === 0x1f && data[1] === 0x8b
        ? gunzipSync(data, { maxOutputLength: MAX_ARTIFACT_BYTES }) : data;
      const shaPath = path.join(dir, "index.sha");
      const shaText = await fs.readFile(shaPath, "utf8").catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const legacy = legacyFormatVersion(raw);
        if (legacy !== undefined) throw new ArtifactVersionError(legacy);
        throw new SectionError("osnova: cache core checksum missing");
      });
      const sha = shaText.trim();
      if (!/^[a-f0-9]{64}$/.test(sha)) throw new SectionError("osnova: cache core checksum corrupt");
      if (sha256Hex(raw) !== sha) throw new SectionError("osnova: cache core checksum mismatch");
      const { envelope: identity, parsed } = envelopeOfCore(raw);
      if (identity.root !== root) throw new Error("osnova: cache artifact belongs to a different workspace");
      const textPath = path.join(dir, "text.bin");
      const textStat = await fs.lstat(textPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SectionError("osnova: cache text sidecar missing");
        throw error;
      });
      if (!textStat.isFile() || textStat.size !== identity.textBytes) throw new SectionError("osnova: cache text sidecar mismatch");
      const edgesPath = path.join(dir, "edges.json");
      const edgesStat = await fs.lstat(edgesPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SectionError("osnova: cache edge sidecar missing");
        throw error;
      });
      if (!edgesStat.isFile() || edgesStat.size > MAX_ARTIFACT_BYTES) throw new SectionError("osnova: cache edge sidecar mismatch");
      const edgesData = await fs.readFile(edgesPath);
      let edgesRaw: Buffer;
      try {
        edgesRaw = edgesData[0] === 0x1f && edgesData[1] === 0x8b
          ? gunzipSync(edgesData, { maxOutputLength: MAX_ARTIFACT_BYTES }) : edgesData;
      } catch (error) {
        throw new SectionError(`osnova: cache edge sidecar unreadable: ${String(error)}`);
      }
      if (edgesRaw.length !== identity.edgesBytes || sha256Hex(edgesRaw) !== identity.edgesHash) {
        throw new SectionError("osnova: cache edge sidecar mismatch");
      }
      const index = new OsnovaIndexImpl(root, {
        path: corePath,
        load: () => deserializeBody(parsed ?? JSON.parse(raw.toString("utf8")), textPath, { path: edgesPath, raw: edgesRaw }),
      });
      bindIndexGeneration(index, sha);
      await recordReader(dir).then(() => touchWorkspace(dir)).catch((error: unknown) => {
        throw new IndexingError({ phase: "cache", path: dir, code: "cache-access-write-failed" }, error);
      });
      return bindIndexCache(index, cacheDir);
    } catch (error) {
      const timeout = cacheLockTimeoutIn(error);
      if (timeout !== undefined) throw timeout;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof ArtifactVersionError && typeof error.version === "number" &&
        Number.isInteger(error.version) && error.version > 0 && error.version < indexFormatVersion) return undefined;
      if (error instanceof ExtractionVersionError) return undefined;
      throw new IndexingError({ phase: "cache", path: dir, code: "cache-read-failed" }, error);
    }
  });
}

async function copyIntoWorkspace(source: string, target: string): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await fs.copyFile(source, temporary, fs.constants.COPYFILE_EXCL);
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export interface SeededArtifact {
  readonly index: OsnovaIndexImpl;
  readonly generation: string;
}

export async function seedArtifactFrom(cacheDir: string, siblingRoot: string, targetRoot: string, options: LockOptions = {}): Promise<SeededArtifact | undefined> {
  const source = workspaceDirFor(cacheDir, siblingRoot);
  const target = workspaceDirFor(cacheDir, targetRoot);
  if (source === target) return undefined;
  return withCacheLock(workspaceLockPath(cacheDir, siblingRoot), async () => {
    try {
      if ((await fs.lstat(source)).isSymbolicLink()) return undefined;
      const corePath = path.join(source, "index.json");
      const coreStat = await fs.lstat(corePath);
      if (!coreStat.isFile() || coreStat.size > MAX_ARTIFACT_BYTES) return undefined;
      const data = await fs.readFile(corePath);
      const raw = data[0] === 0x1f && data[1] === 0x8b ? gunzipSync(data, { maxOutputLength: MAX_ARTIFACT_BYTES }) : data;
      const sha = (await fs.readFile(path.join(source, "index.sha"), "utf8")).trim();
      if (!/^[a-f0-9]{64}$/.test(sha) || sha256Hex(raw) !== sha) return undefined;
      if ((await loadVerification(cacheDir, siblingRoot, sha)) === undefined) return undefined;
      const content = raw.toString("utf8");
      const parsed: unknown = JSON.parse(content);
      const envelope = parsed as { formatVersion?: unknown; extractionVersion?: unknown; root?: unknown; textHash?: unknown; textBytes?: unknown; edgesHash?: unknown; edgesBytes?: unknown };
      if (envelope.formatVersion !== indexFormatVersion || envelope.extractionVersion !== extractionVersion || envelope.root !== siblingRoot) return undefined;
      if (typeof envelope.textHash !== "string" || !nonnegativeInteger(envelope.textBytes)) return undefined;
      if (typeof envelope.edgesHash !== "string" || !nonnegativeInteger(envelope.edgesBytes)) return undefined;
      const textSource = path.join(source, "text.bin");
      const textStat = await fs.lstat(textSource);
      if (!textStat.isFile() || textStat.size !== envelope.textBytes) return undefined;
      const edgesSource = path.join(source, "edges.json");
      const edgesStat = await fs.lstat(edgesSource);
      if (!edgesStat.isFile() || edgesStat.size > MAX_ARTIFACT_BYTES) return undefined;
      const edgesData = await fs.readFile(edgesSource);
      const edgesRaw = edgesData[0] === 0x1f && edgesData[1] === 0x8b ? gunzipSync(edgesData, { maxOutputLength: MAX_ARTIFACT_BYTES }) : edgesData;
      if (edgesRaw.length !== envelope.edgesBytes || sha256Hex(edgesRaw) !== envelope.edgesHash) return undefined;
      await fs.mkdir(target, { recursive: true });
      if ((await fs.lstat(target)).isSymbolicLink()) return undefined;
      const textPath = path.join(target, "text.bin");
      const edgesPath = path.join(target, "edges.json");
      let index: OsnovaIndexImpl | undefined;
      try {
        await copyIntoWorkspace(textSource, textPath);
        await copyIntoWorkspace(edgesSource, edgesPath);
        const textCopy = await fs.readFile(textPath);
        if (textCopy.length === envelope.textBytes && sha256Hex(textCopy) === envelope.textHash) {
          index = deserializeParsedArtifact(parsed, content, textPath, { path: edgesPath, raw: edgesRaw }, undefined, undefined, targetRoot);
        }
      } finally {
        if (index === undefined) await Promise.all([textPath, edgesPath].map((file) => fs.rm(file, { force: true }).catch(() => {})));
      }
      if (index === undefined) return undefined;
      return { index: bindIndexCache(index, cacheDir), generation: sha };
    } catch {
      return undefined;
    }
  }, { lockTimeoutMs: options.lockTimeoutMs ?? 0, lockPollMs: options.lockPollMs });
}

export function isSectionInconsistency(error: unknown): boolean {
  let cause: unknown = error;
  for (let depth = 0; depth < 8 && cause !== null && cause !== undefined; depth += 1) {
    if (cause instanceof SectionError) return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

export const isTextSidecarInconsistency = isSectionInconsistency;

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

export async function artifactTextPathFor(root: string, cacheDir: string): Promise<string | undefined> {
  const file = path.join(workspaceDirFor(cacheDir, root), "text.bin");
  try { await fs.access(file); return file; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

export async function artifactEdgesPathFor(root: string, cacheDir: string): Promise<string | undefined> {
  const file = path.join(workspaceDirFor(cacheDir, root), "edges.json");
  try { await fs.access(file); return file; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}
