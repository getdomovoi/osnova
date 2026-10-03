import type { Node, Tree } from "web-tree-sitter";
import { makeSpan, makeSignature } from "./adapter.js";
import type { RawDefinition, RawEdge } from "./adapter.js";
import type { ArgumentTypes, Callee, Construction, EdgeBinding, EdgeKind, MemberKind, ParameterRange, RouteInfo, SourceSpan, ReturnBinding, SymbolBinding, SymbolKind } from "../types.js";

export type VisitResult = boolean | void;

const childrenMemo = new WeakMap<Tree, Map<number, Node[]>>();

export function childrenOf(node: Node): Node[] {
  let perTree = childrenMemo.get(node.tree);
  if (perTree === undefined) {
    perTree = new Map();
    childrenMemo.set(node.tree, perTree);
  }
  const cached = perTree.get(node.id);
  if (cached !== undefined) return cached;
  const children = node.namedChildren.filter((child): child is Node => child !== null);
  perTree.set(node.id, children);
  return children;
}

export function forgetTree(tree: Tree): void {
  childrenMemo.delete(tree);
}

export function walk(node: Node, visit: (node: Node) => VisitResult): void {
  if (visit(node) === false) return;
  for (const child of childrenOf(node)) {
    walk(child, visit);
  }
}

export function childOfType(node: Node, type: string): Node | null {
  for (const child of childrenOf(node)) {
    if (child.type === type) return child;
  }
  return null;
}

export function childrenOfType(node: Node, type: string): Node[] {
  const out: Node[] = [];
  for (const child of childrenOf(node)) {
    if (child.type === type) out.push(child);
  }
  return out;
}

export function spanOf(node: Node): SourceSpan {
  return makeSpan(node.startPosition.row, node.endPosition.row, node.startPosition.column, node.endPosition.column);
}

export function signatureOf(node: Node, maxLen = 160): string {
  return makeSignature(node.text, maxLen);
}

export function localJoin(parts: readonly string[]): string {
  return parts.filter((p) => p.length > 0).join(".");
}

export class Extractor {
  readonly definitions: RawDefinition[] = [];
  readonly edges: RawEdge[] = [];
  private readonly stack: string[] = [];

  get enclosing(): string {
    return localJoin(this.stack);
  }

  push(name: string): void {
    this.stack.push(name);
  }

  pop(): void {
    this.stack.pop();
  }

  addDef(name: string, kind: SymbolKind, node: Node, signatureNode?: Node, memberKind?: MemberKind, heritage?: readonly SymbolBinding[], fields?: readonly string[], returns?: ReturnBinding, returnTuple?: readonly (ReturnBinding | null)[], fieldTypes?: Readonly<Record<string, SymbolBinding>>, unwrapped?: ReturnBinding, elements?: ReturnBinding, elementTypes?: Readonly<Record<string, SymbolBinding>>, values?: ReturnBinding, valueTypes?: Readonly<Record<string, SymbolBinding>>, aliasOf?: Callee): void {
    const def: RawDefinition = {
      name,
      kind,
      span: spanOf(node),
      signature: signatureOf(signatureNode ?? node),
      parent: this.enclosing,
      ...(memberKind === undefined ? {} : { memberKind }),
      ...(heritage === undefined || heritage.length === 0 ? {} : { heritage }),
      ...(fields === undefined || fields.length === 0 ? {} : { fields }),
      ...(aliasOf === undefined ? {} : { aliasOf }),
      ...(returns === undefined ? {} : { returns }),
      ...(returnTuple === undefined || returnTuple.length === 0 ? {} : { returnTuple }),
      ...(fieldTypes === undefined || Object.keys(fieldTypes).length === 0 ? {} : { fieldTypes }),
      ...(unwrapped === undefined ? {} : { unwrapped }),
      ...(elements === undefined ? {} : { elements }),
      ...(elementTypes === undefined || Object.keys(elementTypes).length === 0 ? {} : { elementTypes }),
      ...(values === undefined ? {} : { values }),
      ...(valueTypes === undefined || Object.keys(valueTypes).length === 0 ? {} : { valueTypes }),
    };
    this.definitions.push(def);
  }

  setParameters(parameters: ParameterRange): void {
    const last = this.definitions.pop();
    if (last !== undefined) this.definitions.push({ ...last, parameters });
  }

  markPrimary(): void {
    const last = this.definitions.pop();
    if (last !== undefined) this.definitions.push({ ...last, primary: true });
  }

  markConditional(): void {
    const last = this.definitions.pop();
    if (last !== undefined) this.definitions.push({ ...last, conditional: true });
  }

  markUnparsedHeader(): void {
    const last = this.definitions.pop();
    if (last !== undefined) this.definitions.push({ ...last, unparsedHeader: true });
  }

  markBaseType(baseType: string): void {
    const last = this.definitions.pop();
    if (last !== undefined) this.definitions.push({ ...last, baseType });
  }

  markNamespace(namespace: string): void {
    const last = this.definitions.pop();
    if (last !== undefined) this.definitions.push({ ...last, namespace });
  }

  markArity(arity: number): void {
    const last = this.definitions.pop();
    if (last !== undefined) this.definitions.push({ ...last, arity });
  }

  markAccess(access: "private" | "package" | "protected"): void {
    const last = this.definitions.pop();
    if (last !== undefined) this.definitions.push({ ...last, access });
  }

  markPartial(identity: string): void {
    const last = this.definitions.pop();
    if (last !== undefined) this.definitions.push({ ...last, partial: identity });
  }

  markMembers(members: readonly string[]): void {
    const last = this.definitions.pop();
    if (last !== undefined) this.definitions.push({ ...last, members });
  }

  markSupertypes(count: number, interfaces: readonly SymbolBinding[]): void {
    const last = this.definitions.pop();
    if (last !== undefined) this.definitions.push({ ...last, supertypes: count, ...(interfaces.length > 0 ? { interfaces } : {}) });
  }

  // The edge sits at the line `node` starts on. A call passes its callee name token, so a call written on its own
  // line of a multi-line chain is not reported at the line where the chain's receiver starts.
  addEdge(kind: EdgeKind, toName: string, node: Node, binding?: EdgeBinding, route?: RouteInfo, args?: number, constructs?: Construction, argumentTypes?: ArgumentTypes): void {
    const name = toName.trim();
    if (name.length === 0 || name.length > 300) return;
    const edge: RawEdge = {
      kind,
      toName: name,
      line: node.startPosition.row + 1,
      enclosing: this.enclosing,
      ...(binding === undefined ? {} : { binding }),
      ...(route === undefined ? {} : { route }),
      ...(args === undefined ? {} : { arguments: args }),
      ...(argumentTypes === undefined ? {} : { argumentTypes }),
      ...(constructs === undefined ? {} : { constructs }),
    };
    this.edges.push(edge);
  }
}

const COMMENT_TYPES = new Set(["comment", "line_comment", "block_comment"]);

// A written type name without its type arguments and whitespace: `Map.Entry<K, V>` is `Map.Entry`.
export function withoutTypeArguments(written: string): string {
  let out = "";
  let depth = 0;
  for (const c of written) {
    if (c === "<") depth += 1;
    else if (c === ">") depth -= 1;
    else if (depth === 0 && !/\s/.test(c)) out += c;
  }
  return out;
}

// The number of arguments written in a call's argument list, comments aside.
export function argumentCount(list: Node | null): number | undefined {
  return list === null ? undefined : childrenOf(list).filter((child) => child.isNamed && !COMMENT_TYPES.has(child.type)).length;
}

export function lastIdentifierNode(node: Node): Node | null {
  if (node.type === "identifier") return node;
  for (const child of childrenOf(node)) {
    const found = lastIdentifierNode(child);
    if (found !== null) return found;
  }
  return null;
}

export function lastIdentifier(node: Node): string | null {
  return lastIdentifierNode(node)?.text ?? null;
}
