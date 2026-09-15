import type { Node, Query, Tree } from "web-tree-sitter";
import type { LanguageId, SymbolKind } from "../types.js";
import { makeSignature, makeSpan } from "./adapter.js";
import type { AdapterOutput, LanguageAdapter, RawDefinition, RawEdge } from "./adapter.js";

const definitionKinds: Readonly<Record<string, SymbolKind>> = {
  "definition.function": "function",
  "definition.method": "method",
  "definition.class": "class",
  "definition.struct": "struct",
  "definition.interface": "interface",
  "definition.trait": "trait",
  "definition.enum": "enum",
  "definition.type": "type",
  "definition.constant": "constant",
  "definition.module": "module",
};

const kindPreference: readonly SymbolKind[] = [
  "method",
  "struct",
  "enum",
  "interface",
  "trait",
  "class",
  "type",
  "constant",
  "module",
  "function",
];

interface Pending {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly node: Node;
}

function contains(outer: Node, inner: Node): boolean {
  return outer.startIndex <= inner.startIndex && outer.endIndex >= inner.endIndex && outer.id !== inner.id;
}

function dedupeSharedNodes(pending: readonly Pending[]): Pending[] {
  const bestBySpan = new Map<string, Pending>();
  const order: string[] = [];
  for (const item of pending) {
    const key = `${item.node.startIndex}:${item.node.endIndex}`;
    const existing = bestBySpan.get(key);
    if (existing === undefined) {
      bestBySpan.set(key, item);
      order.push(key);
      continue;
    }
    if (kindPreference.indexOf(item.kind) < kindPreference.indexOf(existing.kind)) {
      bestBySpan.set(key, item);
    }
  }
  return order.map((key) => bestBySpan.get(key)!);
}

export function makeGenericAdapter(
  language: LanguageId,
  queryText: string,
  compile: (source: string) => Query,
  ignoreCallNames: ReadonlySet<string> = new Set(),
): LanguageAdapter {
  let query: Query | undefined;
  return {
    language,
    extract(tree: Tree, source: string): AdapterOutput {
      query ??= compile(queryText);
      const rawPending: Pending[] = [];
      const calls: Array<{ name: string; node: Node }> = [];
      for (const match of query.matches(tree.rootNode)) {
        const nameCapture = match.captures.find((capture) => capture.name === "name");
        if (nameCapture === undefined) continue;
        const name = nameCapture.node.text.trim();
        if (name.length === 0) continue;
        for (const capture of match.captures) {
          const kind = definitionKinds[capture.name];
          if (kind !== undefined) rawPending.push({ name, kind, node: capture.node });
          else if (capture.name === "reference.call") {
            if (!ignoreCallNames.has(name)) calls.push({ name, node: capture.node });
          }
        }
      }
      const pending = dedupeSharedNodes(rawPending);
      pending.sort((a, b) => a.node.startIndex - b.node.startIndex || b.node.endIndex - a.node.endIndex);
      const qualified: string[] = [];
      const definitions: RawDefinition[] = pending.map((item, i) => {
        let parent = "";
        for (let j = i - 1; j >= 0; j -= 1) {
          if (contains(pending[j]!.node, item.node)) {
            parent = qualified[j]!;
            break;
          }
        }
        const local = parent.length > 0 ? `${parent}.${item.name}` : item.name;
        qualified.push(local);
        return {
          name: item.name,
          kind: item.kind,
          span: makeSpan(item.node.startPosition.row, item.node.endPosition.row, item.node.startPosition.column, item.node.endPosition.column),
          signature: makeSignature(source.slice(item.node.startIndex, item.node.endIndex)),
          parent,
        };
      });
      const edges: RawEdge[] = calls.map((call) => {
        let enclosing = "";
        for (let j = pending.length - 1; j >= 0; j -= 1) {
          if (contains(pending[j]!.node, call.node)) {
            enclosing = qualified[j]!;
            break;
          }
        }
        return { kind: "calls", toName: call.name, line: call.node.startPosition.row + 1, enclosing };
      });
      return { definitions, edges };
    },
  };
}
