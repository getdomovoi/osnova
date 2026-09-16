import type { EdgeBinding, EdgeKind, FileCard, IndexDiagnostic, OsnovaEdge, OsnovaIndex, OsnovaSymbol } from "../types.js";
import { canonical, deserializeEdges } from "./edgeStore.js";
import { IndexingError } from "./diagnostics.js";

export interface RawEdgesByFile {
  readonly [file: string]: readonly RawEdgeItem[];
}

export interface RawEdgeItem {
  readonly kind: EdgeKind;
  readonly toName: string;
  readonly line: number;
  readonly enclosing: string;
  readonly binding?: EdgeBinding | undefined;
}

export function qualifiedNameOf(file: string, local: string): string {
  return local.length > 0 ? `${file}#${local}` : file;
}

export function localOfQualifiedName(qualifiedName: string): string {
  const hash = qualifiedName.indexOf("#");
  return hash >= 0 ? qualifiedName.slice(hash + 1) : "";
}

export function buildSymbolTable(files: ReadonlyMap<string, FileCard>): Map<string, OsnovaSymbol> {
  const symbols = new Map<string, OsnovaSymbol>();
  for (const card of files.values()) {
    for (const symbol of card.symbols) {
      symbols.set(symbol.qualifiedName, symbol);
    }
  }
  return symbols;
}

export interface EdgeSource {
  readonly path: string;
  readonly raw: Buffer;
  readonly paths: readonly string[];
}

interface LoadedEdges {
  readonly edges: OsnovaEdge[];
  readonly incoming: Map<string, OsnovaEdge[]>;
  readonly outgoing: Map<string, OsnovaEdge[]>;
  readonly byFile: Map<string, OsnovaEdge[]>;
}

export class OsnovaIndexImpl implements OsnovaIndex {
  readonly root: string;
  readonly files: Map<string, FileCard>;
  readonly symbols: Map<string, OsnovaSymbol>;
  readonly diagnostics: readonly IndexDiagnostic[];
  private readonly source: EdgeSource | undefined;
  private loaded: LoadedEdges | undefined;

  constructor(root: string, files: Map<string, FileCard>, edges: readonly OsnovaEdge[] | EdgeSource) {
    this.root = root;
    this.files = files;
    this.symbols = buildSymbolTable(files);
    this.diagnostics = [...files.values()].flatMap((file) => file.diagnostics ?? []).sort((a, b) =>
      compareStr(a.path, b.path) || compareStr(a.phase, b.phase) || compareStr(a.code, b.code));
    if (Array.isArray(edges)) {
      this.source = undefined;
      this.loaded = OsnovaIndexImpl.build(edges);
    } else {
      this.source = edges as EdgeSource;
      this.loaded = undefined;
    }
  }

  private static build(edges: readonly OsnovaEdge[]): LoadedEdges {
    const sorted = dedupeEdges([...edges].sort(compareEdges));
    const incoming = new Map<string, OsnovaEdge[]>();
    const outgoing = new Map<string, OsnovaEdge[]>();
    const byFile = new Map<string, OsnovaEdge[]>();
    for (const edge of sorted) {
      pushToMap(byFile, edge.fromFile, edge);
      if (edge.toSymbol !== undefined) pushToMap(incoming, edge.toSymbol, edge);
      if (edge.fromSymbol.length > 0) pushToMap(outgoing, edge.fromSymbol, edge);
    }
    return { edges: sorted, incoming, outgoing, byFile };
  }

  private ensure(): LoadedEdges {
    if (this.loaded !== undefined) return this.loaded;
    const source = this.source!;
    try {
      this.loaded = OsnovaIndexImpl.build(deserializeEdges(source.raw, source.paths, this.files));
    } catch (error) {
      throw new IndexingError({ phase: "cache", path: source.path, code: "cache-read-failed" }, error);
    }
    return this.loaded;
  }

  get edges(): OsnovaEdge[] {
    return this.ensure().edges;
  }

  incoming(qualifiedName: string): readonly OsnovaEdge[] {
    return this.ensure().incoming.get(qualifiedName) ?? [];
  }

  outgoing(qualifiedName: string): readonly OsnovaEdge[] {
    return this.ensure().outgoing.get(qualifiedName) ?? [];
  }

  edgesForFile(path: string): readonly OsnovaEdge[] {
    return this.ensure().byFile.get(path) ?? [];
  }

  edgesLoaded(): boolean {
    return this.loaded !== undefined;
  }
}

function pushToMap<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list === undefined) {
    map.set(key, [value]);
  } else {
    list.push(value);
  }
}

function compareEdges(a: OsnovaEdge, b: OsnovaEdge): number {
  return (
    compareStr(a.fromFile, b.fromFile) ||
    a.line - b.line ||
    compareStr(a.kind, b.kind) ||
    compareStr(a.toName, b.toName) ||
    compareStr(a.toSymbol ?? "", b.toSymbol ?? "") ||
    compareStr(a.toFile ?? "", b.toFile ?? "") ||
    compareStr(a.fromSymbol, b.fromSymbol) ||
    compareStr(canonical(a.binding ?? null), canonical(b.binding ?? null))
  );
}

function dedupeEdges(sorted: OsnovaEdge[]): OsnovaEdge[] {
  const out: OsnovaEdge[] = [];
  let prev: OsnovaEdge | undefined;
  for (const edge of sorted) {
    if (
      prev !== undefined &&
      prev.kind === edge.kind &&
      prev.fromFile === edge.fromFile &&
      prev.fromSymbol === edge.fromSymbol &&
      prev.toName === edge.toName &&
      prev.line === edge.line &&
      prev.toSymbol === edge.toSymbol &&
      prev.toFile === edge.toFile &&
      JSON.stringify(prev.binding ?? null) === JSON.stringify(edge.binding ?? null)
    ) {
      continue;
    }
    out.push(edge);
    prev = edge;
  }
  return out;
}

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
