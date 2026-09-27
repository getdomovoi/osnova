import type { Tree } from "web-tree-sitter";
import type { Callee, EdgeBinding, EdgeKind, MemberKind, ReExport, RouteInfo, SourceSpan, ReturnBinding, SymbolBinding, SymbolKind } from "../types.js";

export interface RawDefinition {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly span: SourceSpan;
  readonly signature: string;
  readonly parent: string;
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

export interface RawEdge {
  readonly kind: EdgeKind;
  readonly toName: string;
  readonly line: number;
  readonly enclosing: string;
  readonly binding?: EdgeBinding | undefined;
  readonly route?: RouteInfo | undefined;
}

export interface AdapterOutput {
  readonly definitions: readonly RawDefinition[];
  readonly edges: readonly RawEdge[];
  readonly reExports?: readonly ReExport[] | undefined;
}

export interface LanguageAdapter {
  readonly language: string;
  extract(tree: Tree, source: string): AdapterOutput;
}

export function makeSpan(startRow: number, endRow: number, startCol: number, endCol: number): SourceSpan {
  return {
    startLine: startRow + 1,
    endLine: endRow + 1,
    startCol,
    endCol,
  };
}

export function makeSignature(text: string, maxLen = 160): string {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLen) return collapsed;
  return `${collapsed.slice(0, maxLen - 1)}…`;
}
