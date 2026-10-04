import type { Node } from "web-tree-sitter";
import { Extractor, childrenOf } from "./util.js";
import type { AdapterOutput, LanguageAdapter } from "./adapter.js";
import type { EdgeBinding, ReExport } from "../types.js";
import { collectTypedBindings, rustSpec } from "./typed-bindings.js";

function lastSegment(text: string): string {
  const parts = text.split("::");
  return parts[parts.length - 1] ?? text;
}

function implTypeName(node: Node): string | null {
  const typeNode = node.childForFieldName("type");
  if (typeNode === null) return null;
  if (typeNode.type === "type_identifier") return typeNode.text;
  if (typeNode.type === "generic_type" || typeNode.type === "scoped_type_identifier") {
    const id = childrenOf(typeNode).find((c) => c.type === "type_identifier");
    return id !== undefined ? id.text : null;
  }
  return null;
}

export const rustAdapter: LanguageAdapter = {
  language: "rust",
  extract(tree, _source): AdapterOutput {
    const out = new Extractor();
    const bindings = collectTypedBindings(tree.rootNode, rustSpec);
    const reExports: ReExport[] = [];

    // A glob of an enum brings in only its variants. That is known exactly only for an enum declared once in the
    // file, directly in the module (or file root) that holds the glob, and named by the glob as `Kind` or
    // `self::Kind`; any other glob might bring in the name, so it binds the call to the glob's path.
    const moduleBody = (node: Node): Node => {
      for (let current: Node | null = node.parent; current !== null; current = current.parent) {
        if (current.type === "mod_item" && current.childForFieldName("body") !== null) return current.childForFieldName("body")!;
        if (current.type === "source_file") return current;
      }
      return tree.rootNode;
    };
    const enumCount = new Map<string, number>();
    const countEnums = (node: Node): void => {
      if (node.type === "enum_item") { const enumName = node.childForFieldName("name")?.text; if (enumName !== undefined) enumCount.set(enumName, (enumCount.get(enumName) ?? 0) + 1); }
      for (const child of childrenOf(node)) countEnums(child);
    };
    countEnums(tree.rootNode);
    const globProvides = (globPath: string, at: Node, name: string): boolean => {
      const enumName = /^(?:self::)?([A-Za-z_]\w*)$/.exec(globPath)?.[1];
      if (enumName === undefined || enumCount.get(enumName) !== 1) return true;
      const declared = childrenOf(moduleBody(at)).find((child) => child.type === "enum_item" && child.childForFieldName("name")?.text === enumName);
      if (declared === undefined) return true;
      return childrenOf(declared.childForFieldName("body") ?? declared).some((variant) => variant.type === "enum_variant" && variant.childForFieldName("name")?.text === name);
    };
    // Every glob in a `use`, grouped ones (`use Kind::{self, *}`, `use a::{b::*, c}`) included, as its path.
    const globPaths = (node: Node, prefix: string, into: string[]): void => {
      const join = (left: string, right: string): string => [left, right].filter((part) => part.length > 0).join("::");
      if (node.type === "use_wildcard") { into.push(join(prefix, node.text.replace(/(^|::)\*$/, ""))); return; }
      if (node.type === "scoped_use_list") {
        const list = node.childForFieldName("list");
        const nested = join(prefix, node.childForFieldName("path")?.text ?? "");
        for (const child of childrenOf(list ?? node)) globPaths(child, nested, into);
        return;
      }
      if (node.type === "use_list" || node.type === "use_declaration") for (const child of childrenOf(node)) globPaths(child, prefix, into);
    };
    // The qualified local name the extractor gives an item declared inside `node`'s ancestors: one segment per
    // enclosing function, trait, impl type (`Type.Trait` for a trait impl) and inline module.
    const scopePath = (node: Node): string[] => {
      const parts: string[] = [];
      for (let current: Node | null = node.parent; current !== null; current = current.parent) {
        if (current.type === "function_item" || current.type === "trait_item" || (current.type === "mod_item" && current.childForFieldName("body") !== null)) {
          const scopeName = current.childForFieldName("name")?.text;
          if (scopeName !== undefined) parts.unshift(scopeName);
        } else if (current.type === "impl_item") {
          const scope = implScope(current);
          if (scope !== null) parts.unshift(scope);
        }
      }
      return parts;
    };

    // What a plain name at `site` names in Rust's item scope, level by level from the innermost block: an item
    // declared at that level (in a block, an exact local binding; in a module body or at the file root, none, and
    // the resolver looks in the caller's module), then a named `use` there, then that level's one glob that may
    // bring the name in. An inline module does not see its parent's items or imports: with none of those, the
    // name is a prelude, std or macro name the index cannot place. A file-root glob keeps the plain-name lookup.
    const plainScope = (site: Node, name: string): EdgeBinding | undefined => {
      const levels: Node[] = [];
      let module: Node | null = null;
      for (let current: Node | null = site.parent; current !== null; current = current.parent) {
        if (current.type === "block") levels.push(current);
        if (current.type === "mod_item" && current.childForFieldName("body") !== null) { module = current; levels.push(current.childForFieldName("body")!); break; }
        if (current.type === "source_file") { levels.push(current); break; }
      }
      for (const level of levels) {
        const children = childrenOf(level);
        const item = children.find((child) => ITEM_KINDS.has(child.type) && child.childForFieldName("name")?.text === name);
        if (item !== undefined) return level.type === "block" ? { kind: "local", name: [...scopePath(item), name].join(".") } : undefined;
        const globs: Array<{ path: string; at: Node }> = [];
        for (const use of children) {
          if (use.type !== "use_declaration") continue;
          const named = rustSpec.imports(use, "use_declaration").find((imported) => imported.local === name);
          if (named !== undefined) {
            const source = bindings.modulePath(named.source, use);
            return source === null ? undefined : { kind: "import", source, importedName: named.name };
          }
          const paths: string[] = [];
          globPaths(use, "", paths);
          for (const globPath of paths) if (globProvides(globPath, use, name)) globs.push({ path: globPath, at: use });
        }
        if (level.type === "source_file") return undefined;
        if (globs.length > 1) return { kind: "blocked", reason: "ambiguous" };
        const glob = globs[0];
        if (glob !== undefined) {
          const source = glob.path.length === 0 ? null : bindings.modulePath(glob.path, glob.at);
          return source === null ? { kind: "blocked", reason: "unbound" } : { kind: "import", source, importedName: name };
        }
      }
      return module === null ? undefined : { kind: "blocked", reason: "unbound" };
    };

    const visit = (node: Node): void => {
      switch (node.type) {
        case "function_item": {
          const nameNode = node.childForFieldName("name");
          if (nameNode !== null) {
            const inTrait = node.parent?.type === "declaration_list" && node.parent?.parent?.type === "trait_item";
            out.addDef(nameNode.text, hasImplAncestor(node) || inTrait ? "method" : "function", node, undefined, bindings.memberKind(node), undefined, undefined, bindings.returns(node), undefined, undefined, bindings.unwrapped(node), bindings.elements(node), undefined, bindings.values(node));
            out.push(nameNode.text);
            for (const child of childrenOf(node)) visit(child);
            out.pop();
          }
          return;
        }
        case "function_signature_item": {
          const nameNode = node.childForFieldName("name");
          if (nameNode !== null) out.addDef(nameNode.text, "method", node, undefined, bindings.memberKind(node), undefined, undefined, bindings.returns(node), undefined, undefined, bindings.unwrapped(node));
          return;
        }
        case "struct_item": {
          const nameNode = node.childForFieldName("name");
          if (nameNode !== null) out.addDef(nameNode.text, "struct", node, undefined, undefined, undefined, undefined, undefined, undefined, bindings.fieldTypes(childrenOf(node.childForFieldName("body") ?? node)), undefined, undefined, bindings.elementTypes(childrenOf(node.childForFieldName("body") ?? node)), undefined, bindings.valueTypes(childrenOf(node.childForFieldName("body") ?? node)));
          return;
        }
        case "enum_item": {
          const nameNode = node.childForFieldName("name");
          if (nameNode !== null) {
            out.addDef(nameNode.text, "enum", node);
            // A tuple variant (`Kind::Io(err)`) is called like a static constructor that returns the enum,
            // so it is indexed as one; unit and struct variants are never called.
            out.push(nameNode.text);
            for (const variant of childrenOf(node.childForFieldName("body") ?? node)) {
              if (variant.type !== "enum_variant") continue;
              const variantName = variant.childForFieldName("name");
              if (variantName !== null && childrenOf(variant).some((child) => child.type === "ordered_field_declaration_list")) out.addDef(variantName.text, "method", variant, undefined, "static", undefined, undefined, { kind: "local", name: nameNode.text });
            }
            out.pop();
          }
          return;
        }
        case "trait_item": {
          const nameNode = node.childForFieldName("name");
          if (nameNode !== null) {
            out.addDef(nameNode.text, "trait", node);
            out.push(nameNode.text);
            for (const child of childrenOf(node)) visit(child);
            out.pop();
          }
          return;
        }
        case "type_item": {
          const nameNode = node.childForFieldName("name");
          if (nameNode !== null) out.addDef(nameNode.text, "type", node);
          return;
        }
        case "const_item":
        case "static_item": {
          const nameNode = node.childForFieldName("name");
          if (nameNode !== null) out.addDef(nameNode.text, "constant", node);
          return;
        }
        case "impl_item": {
          const scope = implScope(node);
          if (scope !== null) {
            // A trait implementation is indexed under Type.Trait so receiver lookup, which sees Type.member, treats only inherent methods as members.
            out.push(scope);
            for (const child of childrenOf(node)) visit(child);
            out.pop();
          } else {
            for (const child of childrenOf(node)) visit(child);
          }
          return;
        }
        case "mod_item": {
          // An inline module is a scope of its own: `check` in `mod tests` and `check` at the file root are two
          // records, and a plain name inside the module names the module's one first. `mod util;` declares a
          // module file, which is no record here.
          const nameNode = node.childForFieldName("name");
          // `#[path = ".."] mod m;` (or under `cfg_attr`) names a file the index does not map. It is recorded as an
          // empty module, so a path through it lands there and names nothing instead of a conventional `m.rs`.
          if (nameNode !== null && node.childForFieldName("body") === null && pathAttribute(node)) out.addDef(nameNode.text, "module", node);
          if (nameNode !== null && node.childForFieldName("body") !== null) {
            out.addDef(nameNode.text, "module", node);
            out.push(nameNode.text);
            for (const child of childrenOf(node)) visit(child);
            out.pop();
          }
          return;
        }
        case "call_expression": {
          const fn = node.childForFieldName("function");
          if (fn !== null) {
            if (fn.type === "identifier") {
              // A closure, parameter or pattern binding called by name shadows every item of the name. A name a `use`
              // brings in from another crate or std is that import's, external when the crate is not in the workspace;
              // a `crate::`, `self::` or `super::` use keeps the plain-name lookup, which already prefers imported files.
              out.addEdge("calls", fn.text, fn, patternBound(node, fn.text) ? { kind: "blocked", reason: "local-value" } : plainScope(node, fn.text));
            } else if (fn.type === "scoped_identifier" || fn.type === "scoped_type_identifier") {
              const nameNode = fn.childForFieldName("name");
              const name = nameNode?.text ?? lastSegment(fn.text);
              if (/^[A-Za-z_]\w*$/.test(name)) out.addEdge("calls", name, nameNode ?? fn, bindings.at(fn, node));
            } else if (fn.type === "field_expression") {
              const field = fn.childForFieldName("field");
              if (field !== null) out.addEdge("calls", field.text, field, bindings.at(fn, node));
            } else if (fn.type === "generic_function") {
              const inner = fn.childForFieldName("function");
              if (inner !== null) {
                const nameNode = inner.type === "identifier" ? inner : inner.childForFieldName("name");
                const name = nameNode?.text ?? lastSegment(inner.text);
                if (/^[A-Za-z_]\w*$/.test(name)) out.addEdge("calls", name, nameNode ?? inner, bindings.at(inner, node));
              }
            }
          }
          for (const child of childrenOf(node)) visit(child);
          return;
        }
        case "macro_invocation": {
          const macro = node.childForFieldName("macro");
          if (macro !== null) out.addEdge("references", macro.text, macro);
          return;
        }
        case "use_declaration": {
          const arg = childrenOf(node).find((c) => c.type !== "visibility_modifier");
          if (arg !== undefined) out.addEdge("imports", arg.text, node);
          // `pub use crate::searcher::Searcher;` at the crate root is how a crate names its public
          // types, so a use of `grep_searcher::Searcher` from another crate follows it as a re-export.
          if (node.parent?.type === "source_file" && childrenOf(node).some((c) => c.type === "visibility_modifier")) {
            const line = node.startPosition.row + 1;
            if (arg?.type === "use_wildcard") {
              const source = arg.text.replace(/::\*$/, "");
              if (source.length > 0) reExports.push({ kind: "star", source, line });
            } else {
              for (const item of rustSpec.imports(node, "use_declaration")) {
                if (item.local === "self") continue;
                reExports.push({ kind: "named", exportedName: item.local, source: item.source, importedName: item.name, line });
              }
            }
          }
          return;
        }
        default: {
          for (const child of childrenOf(node)) visit(child);
        }
      }
    };
    for (const child of childrenOf(tree.rootNode)) visit(child);
    return { definitions: out.definitions, edges: out.edges, reExports };
  },
};

// Whether the attributes written before an item (`#[path = ".."]`, `#[cfg_attr(.., path = "..")]`) set a path.
function pathAttribute(node: Node): boolean {
  for (let sibling = node.previousNamedSibling; sibling !== null; sibling = sibling.previousNamedSibling) {
    if (sibling.type === "line_comment" || sibling.type === "block_comment") continue;
    if (sibling.type !== "attribute_item") return false;
    if (/(^|[\s(,[])path\s*=/.test(sibling.text)) return true;
  }
  return false;
}

// Item declarations a plain name can name in a block or module body.
const ITEM_KINDS = new Set(["function_item", "struct_item", "enum_item", "union_item", "const_item", "static_item", "type_item", "trait_item", "mod_item"]);

// The names a pattern binds: identifiers, and struct-pattern shorthand (`Holder { f }` binds `f`); a field
// name before a colon (`Holder { f: g }`) binds nothing.
function patternNames(pattern: Node | null, into: Set<string>): void {
  if (pattern === null) return;
  if (pattern.type === "identifier" || pattern.type === "shorthand_field_identifier") { into.add(pattern.text); return; }
  for (const child of childrenOf(pattern)) patternNames(child, into);
}

// Whether a plain name at `site` is bound by a pattern in an enclosing scope. A pattern binds only after it:
// a `let` that ends before the site in an enclosing block; the parameters of an enclosing function or
// closure; a match arm's pattern for its guard and value; a `for` pattern for its body; an `if let` or
// `while let` pattern for the later conditions and the body, never for its own value (`if let Some(f) = f()`
// calls the item `f`). Every identifier in a pattern counts, so a unit variant in a match pattern also blocks
// the name; that is a refusal, never a wrong edge.
function patternBound(site: Node, name: string): boolean {
  const names = new Set<string>();
  const at = site.startIndex;
  const after = (node: Node | null, end: number): void => { if (node !== null && end <= at) patternNames(node, names); };
  for (let current: Node | null = site.parent; current !== null; current = current.parent) {
    if (current.type === "block" || current.type === "source_file") {
      for (const child of childrenOf(current)) if (child.type === "let_declaration") after(child.childForFieldName("pattern"), child.endIndex);
    } else if (current.type === "function_item" || current.type === "closure_expression") {
      const parameters = current.childForFieldName("parameters");
      if (parameters !== null) for (const parameter of childrenOf(parameters)) after(parameter.type === "parameter" ? parameter.childForFieldName("pattern") : parameter, parameters.endIndex);
    } else if (current.type === "match_arm") {
      // The grammar's arm pattern holds its guard (`Some(f) if f()`), and the binding is live inside the guard.
      const pattern = current.childForFieldName("pattern");
      const guard = pattern?.childForFieldName("condition") ?? null;
      for (const part of pattern === null ? [] : childrenOf(pattern)) if (part.id !== guard?.id) after(part, guard?.startIndex ?? pattern!.endIndex);
    } else if (current.type === "for_expression") {
      after(current.childForFieldName("pattern"), current.childForFieldName("value")?.endIndex ?? Infinity);
    } else if (current.type === "if_expression" || current.type === "while_expression") {
      const condition = current.childForFieldName("condition");
      const lets = condition?.type === "let_condition" ? [condition] : condition?.type === "let_chain" ? childrenOf(condition).filter((part) => part.type === "let_condition") : [];
      for (const part of lets) after(part.childForFieldName("pattern"), part.endIndex);
    }
    if (names.has(name)) return true;
  }
  return false;
}

// The extractor's scope for an impl block: `Type`, or `Type.Trait` for a trait implementation; null when the
// implemented type is not a plain or generic named type.
function implScope(node: Node): string | null {
  const typeName = implTypeName(node);
  if (typeName === null) return null;
  const traitNode = node.childForFieldName("trait");
  const traitName = traitNode === null ? null : traitNode.type === "type_identifier" ? traitNode.text : childrenOf(traitNode).find((c) => c.type === "type_identifier")?.text ?? null;
  return traitName === null ? typeName : `${typeName}.${traitName}`;
}

function hasImplAncestor(node: Node): boolean {
  let cur: Node | null = node.parent;
  while (cur !== null) {
    if (cur.type === "impl_item") return true;
    cur = cur.parent;
  }
  return false;
}
