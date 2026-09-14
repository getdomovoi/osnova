import type { Tree } from "web-tree-sitter";
import type { EdgeKind, SourceSpan, SymbolKind } from "../types.js";

export interface RawDefinition {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly span: SourceSpan;
  readonly signature: string;
  readonly parent: string;
}

export interface RawEdge {
  readonly kind: EdgeKind;
  readonly toName: string;
  readonly line: number;
  readonly enclosing: string;
}

export interface AdapterOutput {
  readonly definitions: readonly RawDefinition[];
  readonly edges: readonly RawEdge[];
}

export interface LanguageAdapter {
  readonly language: string;
  extract(tree: Tree, source: string): AdapterOutput;
}

export const EMPTY_ADAPTER_OUTPUT: AdapterOutput = { definitions: [], edges: [] };

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

const UPPER_SNAKE = /^[A-Z][A-Z0-9_]*$/;

export function isUpperSnake(name: string): boolean {
  return name.length >= 2 && UPPER_SNAKE.test(name);
}

export function nameOfIdentifier(node: unknown): string {
  return String((node as { text?: string }).text ?? "").trim();
}
