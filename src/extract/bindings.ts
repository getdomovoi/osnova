import type { Node } from "web-tree-sitter";
import type { EdgeBinding } from "../types.js";
import { childrenOf, childOfType } from "./util.js";

interface Scope {
  kind: "module" | "function" | "block" | "class";
  owner: string;
  parent: Scope | null;
  names: Map<string, EdgeBinding[]>;
}

const functions = new Set(["function_declaration", "generator_function_declaration", "function_expression", "function", "generator_function", "arrow_function", "method_definition", "function_definition", "lambda"]);
const classes = new Set(["class_declaration", "abstract_class_declaration", "class_definition"]);
const containers = new Set(["formal_parameters", "parameters", "array_pattern", "object_pattern", "tuple_pattern", "list_pattern", "pattern_list", "rest_pattern", "list_splat_pattern", "dictionary_splat_pattern", "as_pattern_target", "expression_list"]);
const localValue: EdgeBinding = { kind: "blocked", reason: "local-value" };

function patternNames(node: Node | null): string[] {
  if (node === null) return [];
  if (["identifier", "shorthand_property_identifier_pattern"].includes(node.type)) return [node.text];
  if (["pair_pattern"].includes(node.type)) return patternNames(node.childForFieldName("value"));
  if (["assignment_pattern", "object_assignment_pattern"].includes(node.type)) return patternNames(node.childForFieldName("left"));
  if (["required_parameter", "optional_parameter", "typed_parameter", "default_parameter", "typed_default_parameter"].includes(node.type)) {
    return patternNames(node.childForFieldName("pattern") ?? node.childForFieldName("name") ?? childrenOf(node)[0] ?? null);
  }
  return containers.has(node.type) ? childrenOf(node).flatMap(patternNames) : [];
}

export function collectBindings(root: Node, python: boolean): {
  at: (expression: Node | null, site: Node) => EdgeBinding | undefined;
  exportedNames: (name: string, parent: string) => readonly string[];
} {
  const module: Scope = { kind: "module", owner: "", parent: null, names: new Map() };
  const scopes = new Map<number, Scope>();
  const exports = new Map<string, Set<string>>();
  const namespaces = new Set<string>();
  const writes: Array<{ scope: Scope; name: string }> = [];
  const join = (owner: string, name: string): string => owner ? `${owner}.${name}` : name;
  const bind = (scope: Scope, name: string, binding: EdgeBinding): void => {
    const values = scope.names.get(name) ?? [];
    if (!values.some((value) => JSON.stringify(value) === JSON.stringify(binding))) values.push(binding);
    scope.names.set(name, values);
  };
  const bindPattern = (scope: Scope, node: Node | null, binding: EdgeBinding = localValue): void => {
    for (const name of patternNames(node)) bind(scope, name, binding);
  };
  const exportName = (local: string, exported: string): void => {
    const names = exports.get(local) ?? new Set<string>();
    names.add(exported);
    exports.set(local, names);
  };
  const nearestFunction = (scope: Scope): Scope => {
    while (scope.kind === "block" && scope.parent !== null) scope = scope.parent;
    return scope;
  };

  function visit(node: Node, outer: Scope): void {
    let scope = outer;
    if (functions.has(node.type)) {
      const nameNode = node.childForFieldName("name");
      const variableName = node.parent?.type === "variable_declarator" ? node.parent.childForFieldName("name") : null;
      const name = variableName?.type === "identifier" ? variableName.text : nameNode?.text ?? "";
      const owner = name ? join(outer.owner, name) : outer.owner;
      if (["function_definition", "function_declaration", "generator_function_declaration"].includes(node.type) && nameNode !== null) {
        bind(outer, nameNode.text, { kind: "local", name: join(outer.owner, nameNode.text) });
      }
      let parent = outer;
      while (python && parent.kind === "class") parent = parent.parent ?? module;
      const inner: Scope = { kind: "function", owner, parent, names: new Map() };
      bindPattern(inner, node.childForFieldName("parameters") ?? node.childForFieldName("parameter"));
      if (!python && nameNode !== null && !["method_definition", "function_declaration", "generator_function_declaration"].includes(node.type)) {
        bind(inner, nameNode.text, { kind: "local", name: owner });
      }
      scopes.set(node.id, python ? outer : inner);
      const body = node.childForFieldName("body");
      for (const child of childrenOf(node)) visit(child, python && child.id !== body?.id ? outer : inner);
      return;
    }
    if (classes.has(node.type)) {
      const name = node.childForFieldName("name")?.text ?? "";
      if (name) bind(outer, name, { kind: "local", name: join(outer.owner, name) });
      let parent = outer;
      while (python && parent.kind === "class") parent = parent.parent ?? module;
      scope = { kind: "class", owner: join(outer.owner, name), parent, names: new Map() };
    } else if ((!python && ["statement_block", "for_statement", "for_in_statement", "catch_clause"].includes(node.type)) ||
      (python && ["list_comprehension", "set_comprehension", "dictionary_comprehension", "generator_expression"].includes(node.type))) {
      scope = { kind: "block", owner: outer.owner, parent: outer, names: new Map() };
      if (node.type === "catch_clause") bindPattern(scope, node.childForFieldName("parameter"));
    }
    scopes.set(node.id, scope);
    if (!python && node.type === "import_statement") {
      const source = node.childForFieldName("source");
      const moduleName = source === null ? "" : childOfType(source, "string_fragment")?.text ?? "";
      const typeOnly = node.children.some((child) => child?.type === "type");
      const clause = childOfType(node, "import_clause");
      if (clause !== null) {
        for (const child of childrenOf(clause)) {
          if (child.type === "named_imports") {
            for (const specifier of childrenOf(child)) {
              const imported = specifier.childForFieldName("name")?.text;
              const local = specifier.childForFieldName("alias")?.text ?? imported;
              if (local !== undefined && imported !== undefined) bind(scope, local,
                typeOnly || specifier.children.some((part) => part?.type === "type")
                  ? { kind: "blocked", reason: "unsupported" }
                  : { kind: "import", source: moduleName, importedName: imported });
            }
          } else if (child.type === "identifier") {
            bind(scope, child.text, typeOnly ? { kind: "blocked", reason: "unsupported" } : { kind: "import", source: moduleName, importedName: "default" });
          } else if (child.type === "namespace_import") {
            const local = childrenOf(child).find((part) => part.type === "identifier");
            if (local !== undefined) {
              namespaces.add(local.text);
              bind(scope, local.text, typeOnly ? { kind: "blocked", reason: "unsupported" } : { kind: "import", source: moduleName, importedName: "*" });
            }
          }
        }
      }
    }
    if (python && node.type === "import_from_statement") {
      const source = node.childForFieldName("module_name");
      if (childrenOf(node).some((child) => child.type === "wildcard_import")) bind(scope, "*", { kind: "blocked", reason: "unsupported" });
      for (const item of childrenOf(node)) {
        if (item.id === source?.id || item.type === "relative_import" || item.type === "wildcard_import") continue;
        const imported = item.type === "aliased_import" ? item.childForFieldName("name")?.text : item.text;
        const local = item.type === "aliased_import" ? item.childForFieldName("alias")?.text : imported;
        if (local !== undefined && imported !== undefined) bind(scope, local, { kind: "import", source: source?.text ?? "", importedName: imported });
      }
    }
    if (python && node.type === "import_statement") {
      for (const item of childrenOf(node)) {
        const source = item.type === "aliased_import" ? item.childForFieldName("name")?.text : item.text;
        const alias = item.childForFieldName("alias")?.text;
        const local = alias ?? source?.split(".")[0];
        if (local !== undefined && source !== undefined) {
          namespaces.add(local);
          bind(scope, local, { kind: "import", source: alias === undefined ? local : source, importedName: "*" });
        }
      }
    }
    if (!python && node.type === "export_statement" && outer === module && node.childForFieldName("source") === null &&
      !node.children.some((child) => child?.type === "type")) {
      const clause = childOfType(node, "export_clause");
      if (clause !== null) {
        for (const specifier of childrenOf(clause)) {
          if (specifier.children.some((child) => child?.type === "type")) continue;
          const local = specifier.childForFieldName("name")?.text;
          if (local !== undefined) exportName(local, specifier.childForFieldName("alias")?.text ?? local);
        }
      }
      const declaration = node.childForFieldName("declaration");
      if (declaration !== null) {
        const names = declaration.childForFieldName("name")?.text;
        if (names !== undefined) exportName(names, node.children.some((child) => child?.type === "default") ? "default" : names);
        for (const item of childrenOf(declaration)) {
          if (item.type === "variable_declarator") for (const name of patternNames(item.childForFieldName("name"))) exportName(name, name);
        }
      }
    }
    if (!python && node.type === "variable_declarator") {
      const target = node.childForFieldName("name");
      const value = node.childForFieldName("value");
      const destination = node.parent?.type === "variable_declaration" ? nearestFunction(scope) : scope;
      const callable = value !== null && (functions.has(value.type) || ["class", "class_expression"].includes(value.type));
      bindPattern(destination, target, callable && target?.type === "identifier"
        ? { kind: "local", name: join(destination.owner, target.text) } : localValue);
    }
    if (python && ["assignment", "augmented_assignment", "for_statement", "for_in_clause", "named_expression"].includes(node.type)) {
      bindPattern(scope, node.childForFieldName("left") ?? node.childForFieldName("name"));
    }
    if (python && node.type === "as_pattern") bindPattern(scope, node.childForFieldName("alias"));
    if (python && node.type === "delete_statement") for (const child of childrenOf(node)) bindPattern(scope, child);
    if (python && node.type === "match_statement") bind(scope, "*", { kind: "blocked", reason: "unsupported" });
    if (!python && node.type === "for_in_statement") {
      const kind = node.childForFieldName("kind");
      const left = node.childForFieldName("left");
      if (kind !== null) bindPattern(kind.type === "var" ? nearestFunction(scope) : scope, left);
      else for (const name of patternNames(left)) writes.push({ scope, name });
    }
    if (python && ["global_statement", "nonlocal_statement"].includes(node.type)) {
      for (const name of childrenOf(node).filter((child) => child.type === "identifier").map((child) => child.text)) {
        for (let current: Scope | null = scope; current !== null; current = current.parent) bind(current, name, { kind: "blocked", reason: "unsupported" });
      }
    }
    if (!python && ["assignment_expression", "augmented_assignment_expression", "update_expression"].includes(node.type)) {
      const left = node.childForFieldName("left") ?? node.childForFieldName("argument");
      for (const name of patternNames(left)) writes.push({ scope, name });
    }
    for (const child of childrenOf(node)) visit(child, scope);
  }
  visit(root, module);
  for (const write of writes) {
    let scope = write.scope;
    while (!scope.names.has(write.name) && scope.parent !== null) scope = scope.parent;
    bind(scope, write.name, localValue);
  }
  const lookup = (name: string, site: Node): EdgeBinding | undefined => {
    for (let scope: Scope | null = scopes.get(site.id) ?? module; scope !== null; scope = scope.parent) {
      if (scope.names.has("*")) return { kind: "blocked", reason: "unsupported" };
      const bindings = scope.names.get(name);
      if (bindings !== undefined) return bindings.length === 1 ? bindings[0] : { kind: "blocked", reason: "ambiguous" };
    }
    return undefined;
  };
  return {
    at(expression, site) {
      while (expression !== null && ["parenthesized_expression", "non_null_expression"].includes(expression.type)) expression = childrenOf(expression)[0] ?? null;
      if (expression?.type === "identifier") return lookup(expression.text, site) ?? { kind: "blocked", reason: "unsupported" };
      if (expression !== null && ["member_expression", "attribute"].includes(expression.type)) {
        const object = expression.childForFieldName("object");
        const property = expression.childForFieldName(python ? "attribute" : "property");
        if (object?.type === "identifier" && property !== null) {
          const binding = lookup(object.text, site);
          if (binding?.kind === "import" && binding.importedName === "*") return { ...binding, importedName: property.text };
          if (namespaces.has(object.text) && binding?.kind === "blocked") return binding;
        }
        return undefined;
      }
      return { kind: "blocked", reason: "unsupported" };
    },
    exportedNames: (name, parent) => parent !== "" || module.names.has("*") ? [] : python ? [name] : [...(exports.get(name) ?? [])].sort(),
  };
}
