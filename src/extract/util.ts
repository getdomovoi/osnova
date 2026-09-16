import type { Node } from "web-tree-sitter";
import { makeSpan, makeSignature } from "./adapter.js";
import type { RawDefinition, RawEdge } from "./adapter.js";
import type { EdgeBinding, EdgeKind, MemberKind, SourceSpan, SymbolKind } from "../types.js";

export type VisitResult = boolean | void;

export function childrenOf(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null);
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

  addDef(name: string, kind: SymbolKind, node: Node, signatureNode?: Node, memberKind?: MemberKind): void {
    const def: RawDefinition = {
      name,
      kind,
      span: spanOf(node),
      signature: signatureOf(signatureNode ?? node),
      parent: this.enclosing,
      ...(memberKind === undefined ? {} : { memberKind }),
    };
    this.definitions.push(def);
  }

  addEdge(kind: EdgeKind, toName: string, node: Node, binding?: EdgeBinding): void {
    const name = toName.trim();
    if (name.length === 0 || name.length > 300) return;
    const edge: RawEdge = {
      kind,
      toName: name,
      line: node.startPosition.row + 1,
      enclosing: this.enclosing,
      ...(binding === undefined ? {} : { binding }),
    };
    this.edges.push(edge);
  }
}

export function lastIdentifier(node: Node): string | null {
  if (node.type === "identifier") return node.text;
  for (const child of childrenOf(node)) {
    const found = lastIdentifier(child);
    if (found !== null) return found;
  }
  return null;
}

export interface CallNameRule {
  callNodes: readonly string[];
  callTarget: (node: Node) => string | null;
  newNodes?: readonly string[];
  newTarget?: (node: Node) => string | null;
}

export function collectCalls(
  node: Node,
  extractor: Extractor,
  rules: CallNameRule,
  skip?: (node: Node) => boolean,
): void {
  if (rules.callNodes.includes(node.type)) {
    if (skip?.(node) !== true) {
      const name = rules.callTarget(node);
      if (name !== null) extractor.addEdge("calls", name, node);
    }
  }
  if (rules.newNodes !== undefined && rules.newTarget !== undefined && rules.newNodes.includes(node.type)) {
    const name = rules.newTarget(node);
    if (name !== null) extractor.addEdge("calls", name, node);
  }
}
