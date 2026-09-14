import type { Node } from "web-tree-sitter";
import type { EdgeBinding, MemberKind, ReExport, ReceiverMode, SymbolBinding } from "../types.js";
import { childrenOf, childOfType } from "./util.js";

interface Scope {
  kind: "module" | "function" | "block" | "class";
  owner: string;
  parent: Scope | null;
  names: Map<string, EdgeBinding[]>;
  thisBinding?: { owner: SymbolBinding; mode: ReceiverMode } | null | undefined;
}

const functions = new Set(["function_declaration", "generator_function_declaration", "function_expression", "function", "generator_function", "arrow_function", "method_definition", "function_definition", "lambda"]);
const classes = new Set(["class_declaration", "abstract_class_declaration", "class_definition"]);
const containers = new Set(["formal_parameters", "parameters", "array_pattern", "object_pattern", "tuple_pattern", "list_pattern", "pattern_list", "rest_pattern", "list_splat_pattern", "dictionary_splat_pattern", "as_pattern_target", "expression_list"]);
const localValue: EdgeBinding = { kind: "blocked", reason: "local-value" };

export function memberKindOf(node: Node, python: boolean): MemberKind {
  if (!python) {
    if (node.children.some((child) => child?.type === "get" || child?.type === "set") || node.childForFieldName("name")?.text === "constructor") return "property";
    return node.children.some((child) => child?.type === "static") ? "static" : "instance";
  }
  const decorators = node.parent?.type === "decorated_definition" ? childrenOf(node.parent).filter((child) => child.type === "decorator").map((child) => child.text.trim()) : [];
  if (decorators.length === 0) return "instance";
  if (decorators.length !== 1) return "unknown";
  if (decorators[0] === "@staticmethod") return "static";
  if (decorators[0] === "@classmethod") return "class";
  if (decorators[0] === "@property" || /\.(setter|getter|deleter)$/.test(decorators[0] ?? "")) return "property";
  return "unknown";
}

function unwrap(node: Node | null): Node | null {
  while (node !== null && ["parenthesized_expression", "non_null_expression"].includes(node.type)) node = childrenOf(node)[0] ?? null;
  return node;
}

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
  reExports: readonly ReExport[];
  memberKind: (node: Node) => MemberKind;
} {
  const module: Scope = { kind: "module", owner: "", parent: null, names: new Map(), thisBinding: null };
  const scopes = new Map<number, Scope>();
  const exports = new Map<string, Map<string, number>>();
  const reExports: ReExport[] = [];
  const importLines = new Map<EdgeBinding, number>();
  const constructions = new Map<EdgeBinding, { expression: Node; site: Node }>();
  const implicitReceivers: Array<{ node: Node; scope: Scope; parameter: string }> = [];
  const memberWrites: Array<{ object: Node; member: string; scope: Scope }> = [];
  const mutations = new Map<object, Set<string>>();
  const initializers = new Map<EdgeBinding, { end: number; scope: Scope }>();
  const writes: Array<{ scope: Scope; name: string }> = [];
  const join = (owner: string, name: string): string => owner ? `${owner}.${name}` : name;
  const bind = (scope: Scope, name: string, binding: EdgeBinding, line?: number): void => {
    if (line !== undefined) importLines.set(binding, line);
    const values = scope.names.get(name) ?? [];
    if (!values.some((value) => JSON.stringify(value) === JSON.stringify(binding))) values.push(binding);
    scope.names.set(name, values);
  };
  const bindPattern = (scope: Scope, node: Node | null, binding: EdgeBinding = localValue): void => {
    for (const name of patternNames(node)) bind(scope, name, binding);
  };
  const exportName = (local: string, exported: string, line: number): void => {
    const names = exports.get(local) ?? new Map<string, number>();
    names.set(exported, line);
    exports.set(local, names);
  };
  const nearestFunction = (scope: Scope): Scope => {
    while (scope.kind === "block" && scope.parent !== null) scope = scope.parent;
    return scope;
  };
  const construction = (value: Node | null, site: Node): EdgeBinding | undefined => {
    value = unwrap(value);
    if (value?.type !== (python ? "call" : "new_expression")) return undefined;
    const expression = value.childForFieldName(python ? "function" : "constructor");
    if (expression === null) return undefined;
    const binding: EdgeBinding = { kind: "instance", owner: { kind: "local", name: expression.text }, basis: "constructor" };
    constructions.set(binding, { expression, site });
    return binding;
  };
  const recordMemberWrite = (target: Node | null, scope: Scope): void => {
    target = unwrap(target);
    if (target === null || !["member_expression", "attribute", "subscript_expression", "subscript"].includes(target.type)) return;
    const object = unwrap(target.childForFieldName("object") ?? target.childForFieldName("value"));
    const member = target.childForFieldName(python ? "attribute" : "property")?.text ?? "*";
    if (object !== null) memberWrites.push({ object, member, scope });
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
      if (!python && node.type !== "arrow_function") {
        inner.thisBinding = node.type === "method_definition" && outer.kind === "class"
          ? { owner: { kind: "local", name: outer.owner }, mode: node.children.some((child) => child?.type === "static") ? "class" : "instance" }
          : null;
      }
      if (python && outer.kind === "class" && node.type === "function_definition") {
        const kind = memberKindOf(node, true);
        const first = patternNames(node.childForFieldName("parameters"))[0];
        if (first !== undefined && (kind === "instance" || kind === "class" || kind === "property")) {
          inner.names.set(first, [kind === "class" ? { kind: "local", name: outer.owner }
            : { kind: "instance", owner: { kind: "local", name: outer.owner }, basis: "lexical" }]);
          implicitReceivers.push({ node, scope: inner, parameter: first });
        }
      }
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
      scope = { kind: "class", owner: join(outer.owner, name), parent, names: new Map(), thisBinding: null };
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
        if (local !== undefined && imported !== undefined) bind(scope, local, { kind: "import", source: source?.text ?? "", importedName: imported }, item.startPosition.row + 1);
      }
    }
    if (python && node.type === "import_statement") {
      for (const item of childrenOf(node)) {
        const source = item.type === "aliased_import" ? item.childForFieldName("name")?.text : item.text;
        const alias = item.childForFieldName("alias")?.text;
        const local = alias ?? source?.split(".")[0];
        if (local !== undefined && source !== undefined) {
          bind(scope, local, { kind: "import", source: alias === undefined ? local : source, importedName: "*" }, item.startPosition.row + 1);
        }
      }
    }
    if (!python && node.type === "export_statement" && outer === module &&
      !node.children.some((child) => child?.type === "type")) {
      const sourceNode = node.childForFieldName("source");
      const source = sourceNode === null ? null : childOfType(sourceNode, "string_fragment")?.text ?? "";
      const line = node.startPosition.row + 1;
      const clause = childOfType(node, "export_clause");
      if (clause !== null) {
        for (const specifier of childrenOf(clause)) {
          if (specifier.children.some((child) => child?.type === "type")) continue;
          const local = specifier.childForFieldName("name")?.text;
          if (local !== undefined) {
            const exported = specifier.childForFieldName("alias")?.text ?? local;
            const exportLine = specifier.startPosition.row + 1;
            if (source === null) exportName(local, exported, exportLine);
            else reExports.push({ kind: "named", exportedName: exported, source, importedName: local, line: exportLine });
          }
        }
      } else if (source !== null) {
        const namespace = childOfType(node, "namespace_export");
        if (namespace === null) reExports.push({ kind: "star", source, line });
        else {
          const name = childrenOf(namespace).find((child) => child.type === "identifier")?.text;
          if (name !== undefined) reExports.push({ kind: "blocked", exportedName: name, line });
        }
      }
      const declaration = node.childForFieldName("declaration");
      if (declaration !== null) {
        const names = declaration.childForFieldName("name")?.text;
        if (names !== undefined) exportName(names, node.children.some((child) => child?.type === "default") ? "default" : names, line);
        for (const item of childrenOf(declaration)) {
          if (item.type === "variable_declarator") for (const name of patternNames(item.childForFieldName("name"))) exportName(name, name, line);
        }
      }
      const value = node.childForFieldName("value");
      if (source === null && value?.type === "identifier" && node.children.some((child) => child?.type === "default")) exportName(value.text, "default", line);
    }
    if (!python && node.type === "variable_declarator") {
      const target = node.childForFieldName("name");
      const value = node.childForFieldName("value");
      const destination = node.parent?.type === "variable_declaration" ? nearestFunction(scope) : scope;
      const callable = value !== null && (functions.has(value.type) || ["class", "class_expression"].includes(value.type));
      const binding: EdgeBinding = callable && target?.type === "identifier"
        ? { kind: "local", name: join(destination.owner, target.text) }
        : target?.type === "identifier" ? construction(value, node) ?? localValue : localValue;
      bindPattern(destination, target, binding);
      if (binding.kind === "local" || binding.kind === "instance") initializers.set(binding, { end: node.endIndex, scope: nearestFunction(destination) });
    }
    if (python && ["assignment", "augmented_assignment", "for_statement", "for_in_clause", "named_expression"].includes(node.type)) {
      const target = node.childForFieldName("left") ?? node.childForFieldName("name");
      recordMemberWrite(target, scope);
      const binding = node.type === "assignment" && target?.type === "identifier" ? construction(node.childForFieldName("right"), node) ?? localValue : localValue;
      bindPattern(scope, target, binding);
      if (binding.kind === "instance") initializers.set(binding, { end: node.endIndex, scope: nearestFunction(scope) });
    }
    if (python && node.type === "as_pattern") bindPattern(scope, node.childForFieldName("alias"));
    if (python && node.type === "delete_statement") for (const child of childrenOf(node)) { bindPattern(scope, child); recordMemberWrite(child, scope); }
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
      recordMemberWrite(left, scope);
      for (const name of patternNames(left)) writes.push({ scope, name });
    }
    if (!python && node.type === "unary_expression" && node.children.some((child) => child?.type === "delete")) recordMemberWrite(node.childForFieldName("argument"), scope);
    for (const child of childrenOf(node)) visit(child, scope);
  }
  visit(root, module);
  for (const write of writes) {
    let scope = write.scope;
    while (!scope.names.has(write.name) && scope.parent !== null) scope = scope.parent;
    bind(scope, write.name, localValue);
  }
  const forward = (exportedName: string, bindings: readonly EdgeBinding[] | undefined, line: number): void => {
    const binding = bindings?.length === 1 ? bindings[0] : undefined;
    if (binding?.kind === "import" && binding.importedName !== "*") {
      reExports.push({ kind: "named", exportedName, source: binding.source, importedName: binding.importedName, line });
    } else if (binding === undefined || (binding.kind === "blocked" && binding.reason !== "local-value") || binding.kind === "import") {
      reExports.push({ kind: "blocked", exportedName, line });
    }
  };
  if (python) {
    if (module.names.has("*")) reExports.push({ kind: "blocked", exportedName: "*", line: 1 });
    for (const [name, bindings] of module.names) {
      if (name === "*") continue;
      forward(name, bindings, importLines.get(bindings[0] as EdgeBinding) ?? 1);
    }
  } else {
    for (const [local, names] of exports) for (const [name, line] of names) forward(name, module.names.get(local), line);
  }
  reExports.sort((a, b) => a.line - b.line || (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0));
  const lookup = (name: string, site: Node): EdgeBinding | undefined => {
    for (let scope: Scope | null = scopes.get(site.id) ?? module; scope !== null; scope = scope.parent) {
      if (scope.names.has("*")) return { kind: "blocked", reason: "unsupported" };
      const bindings = scope.names.get(name);
      if (bindings !== undefined) {
        if (bindings.length !== 1) return { kind: "blocked", reason: "ambiguous" };
        const binding = bindings[0];
        const initializer = binding === undefined ? undefined : initializers.get(binding);
        if (initializer !== undefined && site.startIndex < initializer.end &&
          nearestFunction(scopes.get(site.id) ?? module) === initializer.scope) return localValue;
        return binding;
      }
    }
    return undefined;
  };
  const memberKind = (node: Node): MemberKind => {
    const kind = memberKindOf(node, python);
    if (!python || node.parent?.type !== "decorated_definition") return kind;
    for (const decorator of childrenOf(node.parent).filter((child) => child.type === "decorator")) {
      const name = decorator.text.trim().slice(1);
      if (["staticmethod", "classmethod", "property"].includes(name) && lookup(name, decorator) !== undefined) return "unknown";
    }
    return kind;
  };
  for (const receiver of implicitReceivers) {
    if (memberKind(receiver.node) === "unknown") receiver.scope.names.set(receiver.parameter, [{ kind: "blocked", reason: "unknown-receiver" }]);
  }
  const thisFor = (scope: Scope): Scope["thisBinding"] => {
    for (let current: Scope | null = scope; current !== null; current = current.parent) {
      if (current.thisBinding !== undefined) return current.thisBinding;
    }
    return null;
  };
  for (const write of memberWrites) {
    const key = write.object.type === "this" ? thisFor(write.scope)
      : write.object.type === "identifier" ? lookup(write.object.text, write.object) : undefined;
    if (key === undefined || key === null) continue;
    const names = mutations.get(key) ?? new Set<string>();
    names.add(write.member);
    mutations.set(key, names);
  }
  const mutated = (key: object | undefined | null, member: string): boolean =>
    key !== undefined && key !== null && (mutations.get(key)?.has(member) === true || mutations.get(key)?.has("*") === true);
  const symbolBinding = (expression: Node | null, site: Node): SymbolBinding | undefined => {
    expression = unwrap(expression);
    if (expression?.type === "identifier") {
      const binding = lookup(expression.text, site);
      return binding?.kind === "local" || binding?.kind === "import" ? binding : undefined;
    }
    if (expression !== null && ["member_expression", "attribute"].includes(expression.type)) {
      const object = expression.childForFieldName("object");
      const property = expression.childForFieldName(python ? "attribute" : "property");
      const binding = object?.type === "identifier" ? lookup(object.text, site) : undefined;
      if (binding?.kind === "import" && binding.importedName === "*" && property !== null) return { ...binding, importedName: property.text };
    }
    return undefined;
  };
  const normalize = (binding: EdgeBinding | undefined): EdgeBinding | undefined => {
    const created = binding === undefined ? undefined : constructions.get(binding);
    if (created === undefined) return binding;
    const owner = symbolBinding(created.expression, created.site);
    return owner === undefined ? { kind: "blocked", reason: "unknown-receiver" } : { kind: "instance", owner, basis: "constructor" };
  };
  return {
    at(expression, site) {
      expression = unwrap(expression);
      if (expression?.type === "identifier") return normalize(lookup(expression.text, site)) ?? { kind: "blocked", reason: "unsupported" };
      if (expression !== null && ["member_expression", "attribute"].includes(expression.type)) {
        const object = unwrap(expression.childForFieldName("object"));
        const property = expression.childForFieldName(python ? "attribute" : "property");
        if (property === null) return { kind: "blocked", reason: "unknown-receiver" };
        if (object?.type === "this") {
          const receiver = thisFor(scopes.get(site.id) ?? module);
          return receiver === null || receiver === undefined || mutated(receiver, property.text) ? { kind: "blocked", reason: "unknown-receiver" }
            : { kind: "member", owner: receiver.owner, member: property.text, mode: receiver.mode, basis: "lexical" };
        }
        const rawBinding = object?.type === "identifier" ? lookup(object.text, site) : construction(object, site);
        if (mutated(rawBinding, property.text)) return { kind: "blocked", reason: "unknown-receiver" };
        const binding = normalize(rawBinding);
        if (binding !== undefined) {
          if (binding?.kind === "import" && binding.importedName === "*") return { ...binding, importedName: property.text };
          if (binding.kind === "instance") return { kind: "member", owner: binding.owner, member: property.text, mode: "instance", basis: binding.basis };
          if (binding.kind === "local" || binding.kind === "import") return { kind: "member", owner: binding, member: property.text, mode: "class", basis: "class-reference" };
        }
        return { kind: "blocked", reason: "unknown-receiver" };
      }
      return { kind: "blocked", reason: "unsupported" };
    },
    exportedNames: (name, parent) => parent !== "" || module.names.has("*") ? [] : python ? [name] : [...(exports.get(name)?.keys() ?? [])].sort(),
    reExports,
    memberKind,
  };
}
