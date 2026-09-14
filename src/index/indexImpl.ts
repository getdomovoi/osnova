import type { EdgeKind, FileCard, OsnovaEdge, OsnovaIndex, OsnovaSymbol } from "../types.js";

export interface RawEdgesByFile {
  readonly [file: string]: readonly RawEdgeItem[];
}

export interface RawEdgeItem {
  readonly kind: EdgeKind;
  readonly toName: string;
  readonly line: number;
  readonly enclosing: string;
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

export class OsnovaIndexImpl implements OsnovaIndex {
  readonly root: string;
  readonly files: Map<string, FileCard>;
  readonly symbols: Map<string, OsnovaSymbol>;
  readonly edges: OsnovaEdge[];
  private readonly incomingBySymbol: Map<string, OsnovaEdge[]>;
  private readonly outgoingBySymbol: Map<string, OsnovaEdge[]>;
  private readonly edgesByFile: Map<string, OsnovaEdge[]>;

  constructor(root: string, files: Map<string, FileCard>, edges: readonly OsnovaEdge[]) {
    this.root = root;
    this.files = files;
    this.symbols = buildSymbolTable(files);
    const sorted = [...edges].sort(compareEdges);
    this.edges = dedupeEdges(sorted);
    this.incomingBySymbol = new Map();
    this.outgoingBySymbol = new Map();
    this.edgesByFile = new Map();
    for (const edge of this.edges) {
      pushToMap(this.edgesByFile, edge.fromFile, edge);
      if (edge.toSymbol !== undefined) pushToMap(this.incomingBySymbol, edge.toSymbol, edge);
      if (edge.fromSymbol.length > 0) pushToMap(this.outgoingBySymbol, edge.fromSymbol, edge);
    }
  }

  incoming(qualifiedName: string): readonly OsnovaEdge[] {
    return this.incomingBySymbol.get(qualifiedName) ?? [];
  }

  outgoing(qualifiedName: string): readonly OsnovaEdge[] {
    return this.outgoingBySymbol.get(qualifiedName) ?? [];
  }

  edgesForFile(path: string): readonly OsnovaEdge[] {
    return this.edgesByFile.get(path) ?? [];
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
    compareStr(a.fromSymbol, b.fromSymbol)
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
      prev.toFile === edge.toFile
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
