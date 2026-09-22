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

interface Target { readonly key: string; readonly row: number; readonly column: number }

const targetKey = (definition: RawDefinition): string => `${definition.span.startLine}:${definition.span.startCol}`;

function startsBefore(node: Node, target: Target): boolean {
  const { row, column } = node.startPosition;
  return row < target.row || (row === target.row && column < target.column);
}

function holds(node: Node, target: Target): boolean {
  const start = node.startPosition, end = node.endPosition;
  if (start.row > target.row || (start.row === target.row && start.column > target.column)) return false;
  return end.row > target.row || (end.row === target.row && end.column >= target.column);
}

// The scope of a declaration is the innermost scope node that starts strictly before it. A
// declaration that is itself a scope (`function twin() {}`) therefore belongs to its parent, and a
// declaration on the line where its method or callback opens still belongs to that method or
// callback, since the comparison is by position, not by line.
function scopeOf(node: Node, target: Target, scope: number): number {
  for (const child of childrenOf(node)) {
    if (!holds(child, target)) continue;
    return scopeOf(child, target, isScope(child) && startsBefore(child, target) ? child.startIndex : scope);
  }
  return scope;
}

function scopeIds(tree: Tree, targets: readonly Target[]): Map<string, number> {
  const found = new Map<string, number>();
  for (const target of targets) found.set(target.key, scopeOf(tree.rootNode, target, tree.rootNode.startIndex));
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
  const targets = new Map<string, Target>();
  for (const definition of contested.flat()) {
    targets.set(targetKey(definition), { key: targetKey(definition), row: definition.span.startLine - 1, column: definition.span.startCol });
  }
  const scopes = scopeIds(tree, [...targets.values()]);
  const shadowed = new Set<string>();
  for (const [key, list] of byName) {
    if (list.length < 2) continue;
    const distinct = new Set(list.map((definition) => scopes.get(targetKey(definition)) ?? -1));
    if (distinct.size > 1) shadowed.add(key);
  }
  if (shadowed.size === 0) return [...definitions];
  return definitions.map((definition) =>
    shadowed.has(localJoin([definition.parent, definition.name])) ? { ...definition, shadowed: true as const } : definition);
}
