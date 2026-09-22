import type { Node, Tree } from "web-tree-sitter";
import type { RawDefinition } from "./adapter.js";
import { childrenOf, localJoin } from "./util.js";

// A declaration's scope is the nearest enclosing function, class or file root. Plain blocks are not
// scopes here on purpose: Python's `if` / `elif` / `else` branches and a language's `try` arms each
// define the same name once for one binding, while two `const x` in two callbacks are two bindings.
const SCOPE_PARTS = [
  "function", "method", "lambda", "closure", "arrow", "constructor",
  "class", "interface", "trait", "struct", "enum", "impl", "protocol", "record",
  "module", "namespace", "package", "program", "source_file", "translation_unit", "compilation_unit",
] as const;

const SCOPE_EXCLUDED = /_(clause|list|type|specifier|modifier|header|parameters|parameter|signature)$/;

function isScope(node: Node): boolean {
  const type = node.type;
  if (SCOPE_EXCLUDED.test(type)) return false;
  return SCOPE_PARTS.some((part) => type.includes(part));
}

function scopeIds(tree: Tree, lines: ReadonlySet<number>): Map<number, number> {
  const found = new Map<number, number>();
  const descend = (node: Node, scope: number): void => {
    for (const child of childrenOf(node)) {
      const startLine = child.startPosition.row + 1;
      const inner = isScope(child) ? child.startIndex : scope;
      if (lines.has(startLine) && !found.has(startLine)) found.set(startLine, scope);
      descend(child, inner);
    }
  };
  descend(tree.rootNode, tree.rootNode.startIndex);
  return found;
}

// Marks every declaration of a name that the file declares in more than one scope. The resolver
// refuses those rather than picking one: the artifact keeps a single record per qualified name, so
// a shadowed local cannot be named, and a wrong target is worse than an unresolved one.
export function markShadowed(tree: Tree, definitions: readonly RawDefinition[]): RawDefinition[] {
  const byName = new Map<string, RawDefinition[]>();
  for (const definition of definitions) {
    const key = localJoin([definition.parent, definition.name]);
    const list = byName.get(key);
    if (list === undefined) byName.set(key, [definition]);
    else list.push(definition);
  }
  const contested = [...byName.values()].filter((list) => list.length > 1);
  if (contested.length === 0) return [...definitions];
  const lines = new Set(contested.flatMap((list) => list.map((definition) => definition.span.startLine)));
  const scopes = scopeIds(tree, lines);
  const shadowed = new Set<string>();
  for (const [key, list] of byName) {
    if (list.length < 2) continue;
    const distinct = new Set(list.map((definition) => scopes.get(definition.span.startLine) ?? -1));
    if (distinct.size > 1) shadowed.add(key);
  }
  if (shadowed.size === 0) return [...definitions];
  return definitions.map((definition) =>
    shadowed.has(localJoin([definition.parent, definition.name])) ? { ...definition, shadowed: true as const } : definition);
}
