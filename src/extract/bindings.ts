import type { Node } from "web-tree-sitter";
import type { Callee, EdgeBinding, MemberKind, ReExport, ReceiverMode, ReceiverOwner, ReturnBinding, SymbolBinding } from "../types.js";
import { childrenOf, childOfType } from "./util.js";
import { canonical } from "../index/edgeStore.js";

interface Scope {
  kind: "module" | "function" | "block" | "class";
  owner: string;
  parent: Scope | null;
  names: Map<string, EdgeBinding[]>;
  thisBinding?: { owner: SymbolBinding; mode: ReceiverMode; classScope?: Scope | undefined } | null | undefined;
  fields?: Map<string, { typeName: string; site: Node; contents?: Contents | undefined }> | undefined;
  constructorFields?: Map<string, { typeName: string; site: Node }> | undefined;
  fieldWrites?: Map<string, number> | undefined;
  classScope?: Scope | undefined;
  constructorScope?: Scope | undefined;
  typeNames?: Map<string, SymbolBinding> | undefined;
}

const nullish = new Set(["undefined", "null"]);

function pythonTypeName(type: Node | null): string | undefined {
  if (type === null) return undefined;
  const inner = type.type === "type" ? childrenOf(type)[0] ?? null : type;
  if (inner === null) return undefined;
  if (inner.type === "identifier" || inner.type === "attribute") return inner.text;
  if (inner.type === "generic_type" || inner.type === "subscript") { const base = childrenOf(inner)[0]; return base !== undefined && (base.type === "identifier" || base.type === "attribute") ? base.text : undefined; }
  return undefined;
}

function annotationTypeName(annotation: Node | null): string | undefined {
  if (annotation === null) return undefined;
  const inner = annotation.type === "type_annotation" ? childrenOf(annotation).find((child) => child.type !== ":") ?? null : annotation;
  if (inner === null) return undefined;
  if (inner.type === "type_identifier" || inner.type === "nested_type_identifier") return inner.text;
  // A primitive names a builtin the index cannot hold, so a call on it classifies as external; any and unknown stay unknown.
  if (inner.type === "predefined_type") return ["string", "number", "boolean", "symbol", "bigint"].includes(inner.text) ? inner.text : undefined;
  // A generic instantiation or an array names its base type: Map<K, V> is a Map, Foo[] is an Array.
  if (inner.type === "generic_type") { const base = childrenOf(inner)[0]; return base !== undefined && (base.type === "type_identifier" || base.type === "nested_type_identifier") ? base.text : undefined; }
  if (inner.type === "array_type") return "Array";
  if (inner.type === "parenthesized_type" || inner.type === "readonly_type") return annotationTypeName(childrenOf(inner).find((child) => child.isNamed) ?? null);
  if (inner.type === "union_type") {
    const members = childrenOf(inner).filter((child) => child.type !== "|" && !(child.type === "literal_type" && nullish.has(child.text)));
    return members.length === 1 ? annotationTypeName(members[0]!) : undefined;
  }
  return undefined;
}

const ELEMENT_GENERICS = new Set(["Array", "ReadonlyArray", "Set", "ReadonlySet", "Iterable", "IterableIterator", "Generator"]);
const VALUE_GENERICS = new Set(["Map", "ReadonlyMap", "WeakMap", "Record"]);
const PYTHON_ELEMENT_GENERICS = new Set(["list", "List", "Sequence", "MutableSequence", "Iterable", "Iterator", "Collection", "set", "Set", "MutableSet", "frozenset", "FrozenSet", "deque", "Deque", "Generator"]);
const PYTHON_VALUE_GENERICS = new Set(["dict", "Dict", "Mapping", "MutableMapping", "defaultdict", "DefaultDict", "OrderedDict"]);
interface Contents { readonly element?: string | undefined; readonly value?: string | undefined }
// What a collection annotation holds: Foo[] and Array<Foo> hold Foos as elements; Map<K, Foo> holds Foos as values.
function contentTypeNames(annotation: Node | null): Contents | undefined {
  if (annotation === null) return undefined;
  const inner = annotation.type === "type_annotation" ? childrenOf(annotation).find((child) => child.type !== ":") ?? null : annotation;
  if (inner === null) return undefined;
  if (inner.type === "array_type") return { element: annotationTypeName(childrenOf(inner).find((child) => child.isNamed) ?? null) };
  if (inner.type === "generic_type") {
    const base = childrenOf(inner)[0];
    if (base === undefined || base.type !== "type_identifier") return undefined;
    const arguments_ = childrenOf(childrenOf(inner).find((child) => child.type === "type_arguments") ?? inner).filter((child) => child.isNamed);
    if (ELEMENT_GENERICS.has(base.text)) return { element: annotationTypeName(arguments_[0] ?? null) };
    if (VALUE_GENERICS.has(base.text)) return { value: annotationTypeName(arguments_[1] ?? null) };
    return undefined;
  }
  if (inner.type === "parenthesized_type" || inner.type === "readonly_type") return contentTypeNames(childrenOf(inner).find((child) => child.isNamed) ?? null);
  if (inner.type === "union_type") {
    const members = childrenOf(inner).filter((child) => child.type !== "|" && !(child.type === "literal_type" && nullish.has(child.text)));
    return members.length === 1 ? contentTypeNames(members[0]!) : undefined;
  }
  return undefined;
}
function pythonContentTypeNames(type: Node | null): Contents | undefined {
  if (type === null) return undefined;
  const inner = type.type === "type" ? childrenOf(type)[0] ?? null : type;
  if (inner === null || (inner.type !== "generic_type" && inner.type !== "subscript")) return undefined;
  const base = childrenOf(inner)[0];
  const baseName = base === undefined ? undefined : base.type === "identifier" ? base.text : base.type === "attribute" ? base.childForFieldName("attribute")?.text : undefined;
  if (baseName === undefined) return undefined;
  const arguments_ = inner.type === "subscript" ? childrenOf(inner).filter((child) => child.isNamed).slice(1) : childrenOf(childrenOf(inner).find((child) => child.type === "type_parameter") ?? inner).filter((child) => child.isNamed);
  if (PYTHON_ELEMENT_GENERICS.has(baseName)) return { element: pythonTypeName(arguments_[0] ?? null) };
  if (PYTHON_VALUE_GENERICS.has(baseName)) return { value: pythonTypeName(arguments_[1] ?? null) };
  return undefined;
}

// A type parameter of an enclosing declaration (`class Box<T>`, `function f<T>()`) names no type the index can hold.
function isTypeParameter(name: string, site: Node): boolean {
  for (let current: Node | null = site; current !== null; current = current.parent) {
    const parameters = current.childForFieldName("type_parameters") ?? childrenOf(current).find((child) => child.type === "type_parameters");
    if (parameters === undefined || parameters === null || parameters.hasError) continue;
    for (const parameter of childrenOf(parameters)) {
      if (parameter.type !== "type_parameter") continue;
      const declared = parameter.childForFieldName("name") ?? childrenOf(parameter).find((child) => child.type === "type_identifier" || child.type === "identifier");
      if (declared?.text === name) return true;
    }
  }
  return false;
}

function enclosingBody(site: Node, root: Node): Node {
  for (let current: Node | null = site.parent; current !== null; current = current.parent) {
    if (functions.has(current.type)) return current.childForFieldName("body") ?? current;
  }
  return root;
}

const functions = new Set(["function_declaration", "generator_function_declaration", "function_expression", "function", "generator_function", "arrow_function", "method_definition", "function_definition", "lambda"]);
const classes = new Set(["class_declaration", "abstract_class_declaration", "class_definition"]);
const containers = new Set(["formal_parameters", "parameters", "lambda_parameters", "array_pattern", "object_pattern", "tuple_pattern", "list_pattern", "pattern_list", "rest_pattern", "list_splat_pattern", "dictionary_splat_pattern", "as_pattern_target", "expression_list"]);
const localValue: EdgeBinding = { kind: "blocked", reason: "local-value" };

export const FUNCTION_VALUE_NODES = new Set([
  "function_expression",
  "arrow_function",
  "function",
  "generator_function",
  "function_signature",
]);
export const FIELD_NODES = new Set(["public_field_definition", "field_definition"]);
const THIS_TYPE = "\0this";
const fieldNameOf = (member: Node): Node | null => member.childForFieldName("name") ?? member.childForFieldName("property");

export function memberKindOf(node: Node, python: boolean, decoratorTexts?: readonly string[]): MemberKind {
  if (!python) {
    if (node.children.some((child) => child?.type === "get" || child?.type === "set") || node.childForFieldName("name")?.text === "constructor") return "property";
    return node.children.some((child) => child?.type === "static") ? "static" : "instance";
  }
  const decorators = decoratorTexts ?? (node.parent?.type === "decorated_definition" ? childrenOf(node.parent).filter((child) => child.type === "decorator").map((child) => child.text.trim()) : []);
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

function reassigns(body: Node, name: string, except?: number): boolean {
  const stack: Node[] = [body];
  while (stack.length > 0) {
    const node = stack.pop()!;
    // A block-scoped loop declaration (`for (const x of xs)`) declares, it does not reassign.
    const declares = node.type === "for_in_statement" && node.childForFieldName("kind") !== null && node.childForFieldName("kind")?.type !== "var";
    if (node.id !== except && !declares && ["assignment", "augmented_assignment", "for_statement", "for_in_clause", "named_expression", "as_pattern", "global_statement", "nonlocal_statement",
      "assignment_expression", "augmented_assignment_expression", "update_expression", "for_in_statement"].includes(node.type)) {
      const target = node.childForFieldName("left") ?? node.childForFieldName("name") ?? node.childForFieldName("alias") ?? node.childForFieldName("argument");
      if (target !== null && patternNames(unwrap(target) ?? target).includes(name)) return true;
      if (node.type === "global_statement" || node.type === "nonlocal_statement") return true;
    }
    if (node.type === "delete_statement") {
      const inner: Node[] = [...childrenOf(node)];
      while (inner.length > 0) {
        const item = inner.pop()!;
        if (item.type === "identifier" && item.text === name) return true;
        if (item.type === "attribute" || item.type === "subscript") continue;
        inner.push(...childrenOf(item));
      }
    }
    if (functions.has(node.type) && node.id !== body.parent?.id) {
      const params = patternNames(node.childForFieldName("parameters") ?? node.childForFieldName("parameter"));
      if (params.includes(name)) continue;
    }
    for (const child of childrenOf(node)) stack.push(child);
  }
  return false;
}

export function collectBindings(root: Node, python: boolean): {
  at: (expression: Node | null, site: Node) => EdgeBinding | undefined;
  heritage: (node: Node) => SymbolBinding[];
  returns: (node: Node) => ReturnBinding | undefined;
  ownFields: (node: Node) => string[];
  unwrapped: (node: Node) => ReturnBinding | undefined;
  elements: (node: Node) => ReturnBinding | undefined;
  values: (node: Node) => ReturnBinding | undefined;
  elementTypes: (node: Node) => Record<string, SymbolBinding> | undefined;
  valueTypes: (node: Node) => Record<string, SymbolBinding> | undefined;
  fieldTypes: (node: Node) => Record<string, SymbolBinding> | undefined;
  exportedNames: (name: string, parent: string) => readonly string[];
  reExports: readonly ReExport[];
  memberKind: (node: Node) => MemberKind;
} {
  const module: Scope = { kind: "module", owner: "", parent: null, names: new Map(), thisBinding: null };
  const scopes = new Map<number, Scope>();
  const exports = new Map<string, Map<string, number>>();
  const reExports: ReExport[] = [];
  const importLines = new Map<EdgeBinding, number>();
  const constructions = new Map<EdgeBinding, { expression: Node; site: Node; call?: boolean ; awaited?: boolean }>();
  const pendingProperties: Array<{ fields: Map<string, { typeName: string; site: Node }>; name: string; inner: Node; decorator: Node }> = [];
  const ambient = new Set<string>();
  const implicitReceivers: Array<{ node: Node; scope: Scope; parameter: string }> = [];
  const annotated: Array<{ scope: Scope; parameter: string; typeName: string; site: Node }> = [];
  // Loop variables and callback parameters take the element type of the collection they range over.
  const loops: Array<{ scope: Scope; name: string; source: Node; site: Node; mode?: "value" | "either" | undefined }> = [];
  const contentsOf = new Map<EdgeBinding, { element?: SymbolBinding | undefined; value?: SymbolBinding | undefined }>();
  // A local that aliases a member chain or an indexed element takes that owner.
  const aliases: Array<{ scope: Scope; name: string; value: Node; site: Node }> = [];
  const CALLBACK_METHODS = new Set(["forEach", "map", "filter", "some", "every", "find", "findIndex", "findLast", "findLastIndex", "flatMap"]);
  const memberWrites: Array<{ object: Node; member: string; scope: Scope }> = [];
  const mutations = new Map<object, Set<string>>();
  const initializers = new Map<EdgeBinding, { end: number; scope: Scope }>();
  const writes: Array<{ scope: Scope; name: string }> = [];
  const join = (owner: string, name: string): string => owner ? `${owner}.${name}` : name;
  const bind = (scope: Scope, name: string, binding: EdgeBinding, line?: number): void => {
    if (line !== undefined) importLines.set(binding, line);
    const values = scope.names.get(name) ?? [];
    if (!values.some((value) => canonical(value) === canonical(binding))) values.push(binding);
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
    const awaited = value !== null && value.type === (python ? "await" : "await_expression");
    if (awaited) value = unwrap(childrenOf(value!).find((child) => child.isNamed) ?? null);
    if (value === null || !(value.type === (python ? "call" : "new_expression") || value.type === (python ? "call" : "call_expression"))) return undefined;
    const expression = value.childForFieldName(value.type === "new_expression" ? "constructor" : "function");
    if (expression === null) return undefined;
    const call = value.type !== "new_expression";
    if (awaited && !call) return undefined;
    const binding: EdgeBinding = { kind: "instance", owner: { kind: "local", name: expression.text }, basis: call && !python ? "return" : "constructor" };
    constructions.set(binding, { expression, site, call, awaited });
    return binding;
  };
  const classOf = (scope: Scope): Scope | null => {
    for (let current: Scope | null = scope; current !== null; current = current.parent) {
      if (current.kind === "class") return current;
      if (current.classScope !== undefined) return current.classScope;
    }
    return null;
  };
  const recordFieldWrite = (target: Node, scope: Scope, value: Node | null): void => {
    const object = unwrap(target.childForFieldName("object"));
    const member = target.childForFieldName(python ? "attribute" : "property")?.text;
    if (object === null || member === undefined) return;
    const fn = nearestFunction(scope);
    const isSelf = python ? (object.type === "identifier" && fn.kind === "function" && fn.names.get(object.text)?.[0]?.kind === "instance") : object.type === "this";
    if (!isSelf) return;
    const cls = classOf(scope);
    if (cls === null || cls.constructorFields === undefined || cls.fieldWrites === undefined) return;
    cls.fieldWrites.set(member, (cls.fieldWrites.get(member) ?? 0) + 1);
    if (fn !== cls.constructorScope) return;
    const created = unwrap(value);
    const callee = created?.type === (python ? "call" : "new_expression") ? unwrap(created.childForFieldName(python ? "function" : "constructor")) : null;
    const typeName = callee?.type === "identifier" ? callee.text : callee !== null && ["member_expression", "attribute"].includes(callee.type) ? callee.text : undefined;
    if (typeName !== undefined && !cls.constructorFields.has(member)) cls.constructorFields.set(member, { typeName, site: target });
  };
  const recordMemberWrite = (target: Node | null, scope: Scope, value: Node | null = null): void => {
    target = unwrap(target);
    if (target === null || !["member_expression", "attribute", "subscript_expression", "subscript"].includes(target.type)) return;
    if (target.type === "member_expression" || target.type === "attribute") recordFieldWrite(target, scope, value);
    const object = unwrap(target.childForFieldName("object") ?? target.childForFieldName("value"));
    const member = target.childForFieldName(python ? "attribute" : "property")?.text ?? "*";
    if (object !== null) memberWrites.push({ object, member, scope });
  };

  function visit(node: Node, outer: Scope): void {
    if (!python && node.type === "ambient_declaration") {
      for (const child of childrenOf(node)) {
        const signatures = child.type === "function_signature" ? [child] : child.type === "statement_block" ? childrenOf(child).filter((item) => item.type === "function_signature") : [];
        for (const signature of signatures) { const name = signature.childForFieldName("name")?.text; if (name !== undefined) ambient.add(name); }
      }
    }
    let scope = outer;
    if (functions.has(node.type)) {
      const nameNode = node.childForFieldName("name");
      const variableName = node.parent?.type === "variable_declarator" || (node.parent !== null && FIELD_NODES.has(node.parent.type)) ? fieldNameOf(node.parent) : null;
      const name = variableName?.type === "identifier" || variableName?.type === "property_identifier" ? variableName.text : nameNode?.text ?? "";
      const owner = name ? join(outer.owner, name) : outer.owner;
      if (["function_definition", "function_declaration", "generator_function_declaration"].includes(node.type) && nameNode !== null) {
        bind(outer, nameNode.text, { kind: "local", name: join(outer.owner, nameNode.text) });
      }
      let parent = outer;
      while (python && parent.kind === "class") parent = parent.parent ?? module;
      const inner: Scope = { kind: "function", owner, parent, names: new Map() };
      bindPattern(inner, node.childForFieldName("parameters") ?? node.childForFieldName("parameter"));
      if (!python && (node.type === "arrow_function" || node.type === "function_expression" || node.type === "function") && node.parent?.type === "arguments" && childrenOf(node.parent)[0]?.id === node.id) {
        const call = node.parent.parent;
        const callee = call?.type === "call_expression" ? call.childForFieldName("function") : null;
        const first = childrenOf(node.childForFieldName("parameters") ?? node).find((child) => child.isNamed);
        const single = node.childForFieldName("parameter");
        const name = single?.type === "identifier" ? single : first?.type === "required_parameter" && first.childForFieldName("type") === null ? first.childForFieldName("pattern") : null;
        if (callee?.type === "member_expression" && CALLBACK_METHODS.has(callee.childForFieldName("property")?.text ?? "") && name?.type === "identifier") {
          const object = callee.childForFieldName("object");
          if (object !== null) loops.push({ scope: inner, name: name.text, source: object, site: node, mode: callee.childForFieldName("property")?.text === "forEach" ? "either" : undefined });
        }
      }
      if (outer.kind === "class" && ((python && node.type === "function_definition" && nameNode?.text === "__init__") ||
        (!python && node.type === "method_definition" && nameNode?.text === "constructor"))) outer.constructorScope = inner;
      if (!python && node.type !== "arrow_function") {
        inner.thisBinding = node.type === "method_definition" && outer.kind === "class"
          ? { owner: { kind: "local", name: outer.owner }, mode: node.children.some((child) => child?.type === "static") ? "class" : "instance", classScope: outer }
          : null;
      }
      if (!python) {
        for (const parameter of childrenOf(node.childForFieldName("parameters") ?? node)) {
          if (parameter.type !== "required_parameter" && parameter.type !== "optional_parameter") continue;
          const pattern = parameter.childForFieldName("pattern");
          const typeName = annotationTypeName(parameter.childForFieldName("type"));
          if (pattern?.type === "identifier" && typeName !== undefined) annotated.push({ scope: inner, parameter: pattern.text, typeName, site: parameter });
        }
      }
      if (python && node.type === "function_definition") {
        for (const parameter of childrenOf(node.childForFieldName("parameters") ?? node)) {
          if (parameter.type !== "typed_parameter" && parameter.type !== "typed_default_parameter") continue;
          if (childrenOf(parameter).some((child) => child.type === "list_splat_pattern" || child.type === "dictionary_splat_pattern")) continue;
          const name = patternNames(parameter)[0];
          const type = parameter.childForFieldName("type");
          const typeText = pythonTypeName(type);
          if (name === undefined || typeText === undefined) continue;
          annotated.push({ scope: inner, parameter: name, typeName: typeText, site: parameter });
        }
      }
      if (python && outer.kind === "class" && node.type === "function_definition") {
        inner.classScope = outer;
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
    if (!python && node.type === "interface_declaration") {
      const name = node.childForFieldName("name")?.text ?? "";
      if (name) bind(outer, name, { kind: "local", name: join(outer.owner, name) });
    }
    if (!python && (node.type === "internal_module" || node.type === "module")) {
      const nameNode = node.childForFieldName("name");
      if (nameNode?.type === "identifier") {
        bind(outer, nameNode.text, { kind: "local", name: join(outer.owner, nameNode.text) });
        scope = { kind: "block", owner: join(outer.owner, nameNode.text), parent: outer, names: new Map() };
      }
    }
    if (classes.has(node.type)) {
      const name = node.childForFieldName("name")?.text ?? "";
      if (name) bind(outer, name, { kind: "local", name: join(outer.owner, name) });
      let parent = outer;
      while (python && parent.kind === "class") parent = parent.parent ?? module;
      scope = { kind: "class", owner: join(outer.owner, name), parent, names: new Map(), thisBinding: null };
      if (!python) {
        const fields = new Map<string, { typeName: string; site: Node; contents?: Contents | undefined }>();
        for (const member of childrenOf(node.childForFieldName("body") ?? node)) {
          if (FIELD_NODES.has(member.type) && !member.children.some((child) => child?.type === "static")) {
            const fieldName = fieldNameOf(member);
            const typeName = annotationTypeName(member.childForFieldName("type"));
            if (fieldName?.type === "property_identifier" && typeName !== undefined) fields.set(fieldName.text, { typeName, site: node, contents: contentTypeNames(member.childForFieldName("type")) });
          }
          if (member.type === "method_definition" && member.childForFieldName("name")?.text === "constructor") {
            for (const parameter of childrenOf(member.childForFieldName("parameters") ?? member)) {
              if (!parameter.children.some((child) => child?.type === "accessibility_modifier" || child?.type === "readonly" || child?.type === "override_modifier")) continue;
              const pattern = parameter.childForFieldName("pattern");
              const typeName = annotationTypeName(parameter.childForFieldName("type"));
              if (pattern?.type === "identifier" && typeName !== undefined) fields.set(pattern.text, { typeName, site: node, contents: contentTypeNames(parameter.childForFieldName("type")) });
            }
          }
        }
        scope.fields = fields;
      } else {
        // Class-body annotations (`conn: Conn`) and property return types (`def conn(self) -> Conn`) type Python fields.
        // Decisions that need bindings (the builtin property, typing.Self) wait until the walk has finished.
        const fields = new Map<string, { typeName: string; site: Node; contents?: Contents | undefined }>();
        const plainMethods = new Set<string>();
        for (const statement of childrenOf(node.childForFieldName("body") ?? node)) {
          const definition = statement.type === "decorated_definition" ? statement.childForFieldName("definition") : statement;
          const decorated = statement.type === "decorated_definition" ? childrenOf(statement).filter((child) => child.type === "decorator") : [];
          const isProperty = decorated.length === 1 && decorated[0]?.text.trim() === "@property";
          if (definition?.type === "function_definition" && !isProperty) { const name = definition.childForFieldName("name")?.text; if (name !== undefined) plainMethods.add(name); }
          const assignment = statement.type === "expression_statement" ? childrenOf(statement)[0] : null;
          if (assignment?.type === "assignment") {
            const left = assignment.childForFieldName("left");
            const typeName = pythonTypeName(assignment.childForFieldName("type"));
            if (left?.type === "identifier" && typeName !== undefined) fields.set(left.text, { typeName, site: node, contents: pythonContentTypeNames(assignment.childForFieldName("type")) });
          }
          if (definition?.type === "function_definition" && isProperty && decorated[0] !== undefined) {
            const name = definition.childForFieldName("name")?.text;
            const type = definition.childForFieldName("return_type");
            const inner = type === null ? null : type.type === "type" ? childrenOf(type)[0] ?? null : type;
            const base = inner === null ? null : inner.type === "generic_type" || inner.type === "subscript" ? childrenOf(inner)[0] ?? null : inner;
            if (name !== undefined && base !== null && (base.type === "identifier" || base.type === "attribute")) pendingProperties.push({ fields, name, inner: base, decorator: decorated[0] });
          }
        }
        for (const name of plainMethods) fields.delete(name);
        scope.fields = fields;
      }
      scope.constructorFields = new Map();
      scope.fieldWrites = new Map();
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
              if (local !== undefined && imported !== undefined) {
                const binding: SymbolBinding = { kind: "import", source: moduleName, importedName: imported };
                if (typeOnly || specifier.children.some((part) => part?.type === "type")) {
                  bind(scope, local, { kind: "blocked", reason: "unsupported" });
                  (scope.typeNames ??= new Map()).set(local, binding);
                } else bind(scope, local, binding);
              }
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
          if (name !== undefined) reExports.push({ kind: "namespace", exportedName: name, source, line });
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
      const typeName = (binding === localValue || constructions.get(binding)?.call === true) && target?.type === "identifier" ? annotationTypeName(node.childForFieldName("type")) : undefined;
      if (typeName !== undefined && target?.type === "identifier") annotated.push({ scope: destination, parameter: target.text, typeName, site: node });
      const aliased = unwrap(value);
      if (binding === localValue && typeName === undefined && target?.type === "identifier" && aliased !== null && (aliased.type === "member_expression" || aliased.type === "subscript_expression")) aliases.push({ scope: destination, name: target.text, value: aliased, site: node });
    }
    if (python && ["assignment", "augmented_assignment", "for_statement", "for_in_clause", "named_expression"].includes(node.type)) {
      const target = node.childForFieldName("left") ?? node.childForFieldName("name");
      recordMemberWrite(target, scope, node.type === "assignment" ? node.childForFieldName("right") : null);
      const binding = node.type === "assignment" && target?.type === "identifier" ? construction(node.childForFieldName("right"), node) ?? localValue : localValue;
      bindPattern(scope, target, binding);
      const iterated = node.type === "for_statement" || node.type === "for_in_clause" ? node.childForFieldName("right") : null;
      if (iterated !== null && target?.type === "identifier") loops.push({ scope, name: target.text, source: iterated, site: node });
      const right = node.type === "assignment" ? unwrap(node.childForFieldName("right")) : null;
      if (binding === localValue && node.childForFieldName("type") === null && target?.type === "identifier" && right !== null && (right.type === "attribute" || right.type === "subscript")) aliases.push({ scope, name: target.text, value: right, site: node });
      if (binding.kind === "instance") initializers.set(binding, { end: node.endIndex, scope: nearestFunction(scope) });
    }
    if (python && node.type === "as_pattern") bindPattern(scope, node.childForFieldName("alias"));
    if (python && node.type === "delete_statement") for (const child of childrenOf(node)) { bindPattern(scope, child); recordMemberWrite(child, scope); }
    if (python && node.type === "match_statement") bind(scope, "*", { kind: "blocked", reason: "unsupported" });
    if (!python && node.type === "for_in_statement") {
      const kind = node.childForFieldName("kind");
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      if (kind !== null) bindPattern(kind.type === "var" ? nearestFunction(scope) : scope, left);
      else for (const name of patternNames(left)) writes.push({ scope, name });
      if (kind !== null && kind.type !== "var" && left?.type === "identifier" && right !== null && node.childForFieldName("operator")?.text === "of") loops.push({ scope, name: left.text, source: right, site: node });
    }
    if (python && ["global_statement", "nonlocal_statement"].includes(node.type)) {
      for (const name of childrenOf(node).filter((child) => child.type === "identifier").map((child) => child.text)) {
        for (let current: Scope | null = scope; current !== null; current = current.parent) bind(current, name, { kind: "blocked", reason: "unsupported" });
      }
    }
    if (!python && ["assignment_expression", "augmented_assignment_expression", "update_expression"].includes(node.type)) {
      const left = node.childForFieldName("left") ?? node.childForFieldName("argument");
      recordMemberWrite(left, scope, node.type === "assignment_expression" ? node.childForFieldName("right") : null);
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
    } else if (binding?.kind === "import") {
      // `import * as ns from "./x"; export { ns }` forwards the whole module under the exported name.
      reExports.push({ kind: "namespace", exportedName, source: binding.source, line });
    } else if (binding === undefined || (binding.kind === "blocked" && binding.reason !== "local-value")) {
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
  const isTypingOverload = (decorator: Node): boolean => {
    const text = decorator.text.trim().slice(1);
    if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?$/.test(text)) return false;
    const [head, member] = text.split(".");
    if (head === undefined) return false;
    const binding = lookup(head, decorator);
    if (binding?.kind !== "import" || !["typing", "typing_extensions"].includes(binding.source)) return false;
    return member === undefined ? binding.importedName === "overload" : member === "overload" && binding.importedName === "*";
  };
  const memberKind = (node: Node): MemberKind => {
    if (!python || node.parent?.type !== "decorated_definition") return memberKindOf(node, python);
    const decorators = childrenOf(node.parent).filter((child) => child.type === "decorator");
    const kind = memberKindOf(node, python, decorators.filter((decorator) => !isTypingOverload(decorator)).map((decorator) => decorator.text.trim()));
    for (const decorator of decorators) {
      const name = decorator.text.trim().slice(1);
      if (["staticmethod", "classmethod", "property"].includes(name) && lookup(name, decorator) !== undefined) return "unknown";
    }
    return kind;
  };
  for (const receiver of implicitReceivers) {
    if (memberKind(receiver.node) === "unknown") receiver.scope.names.set(receiver.parameter, [{ kind: "blocked", reason: "unknown-receiver" }]);
  }
  const typeLookup = (name: string, site: Node): SymbolBinding | undefined => {
    for (let scope: Scope | null = scopes.get(site.id) ?? module; scope !== null; scope = scope.parent) {
      const typed = scope.typeNames?.get(name);
      if (typed !== undefined) return (scope.names.get(name) ?? []).filter((binding) => binding !== localValue).length <= 1 ? typed : undefined;
      if (scope.names.has(name) || scope.names.has("*")) return undefined;
    }
    return undefined;
  };
  const typeBinding = (name: string, site: Node): SymbolBinding | undefined => {
    const typed = typeLookup(name, site);
    if (typed !== undefined) return typed;
    for (let scope: Scope | null = scopes.get(site.id) ?? module; scope !== null; scope = scope.parent) {
      if (scope.names.has("*")) return undefined;
      const bindings = scope.names.get(name);
      if (bindings === undefined) continue;
      const capable = [...new Map(bindings.flatMap((binding) => binding.kind === "local" || binding.kind === "import" ? [[JSON.stringify(binding), binding] as const] : [])).values()];
      return capable.length === 1 ? capable[0] : undefined;
    }
    return undefined;
  };
  const ownerFor = (typeName: string, site: Node, valueOnly = false): SymbolBinding | undefined => {
    const dotted = typeName.split(".");
    const head = lookup(dotted[0]!, site) ?? (valueOnly ? undefined : typeLookup(dotted[0]!, site));
    // An unbound type name is a builtin or an ambient type; a local binding lets resolution say so.
    if (head === undefined) return dotted.length === 1 && !valueOnly && !(!python && isTypeParameter(dotted[0]!, site)) ? { kind: "local", name: dotted[0]! } : undefined;
    // A type position ignores value bindings: an interface that shares its name with a const still names the interface.
    if (!valueOnly && head.kind === "blocked") { const typed = typeBinding(dotted[0]!, site); if (typed !== undefined) return dotted.length === 1 ? typed : dotted.length === 2 && typed.kind === "import" && typed.importedName === "*" ? { ...typed, importedName: dotted[1]! } : undefined; }
    if (dotted.length === 1) return head.kind === "local" || head.kind === "import" ? head : undefined;
    if (dotted.length === 2 && head.kind === "import" && head.importedName === "*") return { ...head, importedName: dotted[1]! };
    return undefined;
  };
  for (const entry of annotated) {
    const current = entry.scope.names.get(entry.parameter);
    if (current === undefined || current.length !== 1 || (current[0] !== localValue && constructions.get(current[0]!)?.call !== true)) continue;
    const owner = ownerFor(entry.typeName, entry.site);
    if (owner === undefined) continue;
    if (reassigns(enclosingBody(entry.site, root), entry.parameter)) continue;
    const binding: EdgeBinding = { kind: "instance", owner, basis: "annotation" };
    entry.scope.names.set(entry.parameter, [binding]);
    const contents = python ? pythonContentTypeNames(entry.site.childForFieldName("type")) : contentTypeNames(entry.site.childForFieldName("type"));
    const element = contents?.element === undefined ? undefined : ownerFor(contents.element, entry.site);
    const value = contents?.value === undefined ? undefined : ownerFor(contents.value, entry.site);
    if (element !== undefined || value !== undefined) contentsOf.set(binding, { element, value });
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
  const calleeOf = (expression: Node | null, site: Node): Callee | undefined => {
    const owner = symbolBinding(expression, site);
    if (owner !== undefined) return owner;
    expression = unwrap(expression);
    if (expression === null || !["member_expression", "attribute"].includes(expression.type)) return undefined;
    const target = at(expression, site);
    return target?.kind === "member" ? { kind: "method", owner: target.owner, member: target.member, mode: target.mode } : undefined;
  };
  // Every wrapper counts: a chain the resolver will never follow (its limit is six hops) is not worth storing,
  // and the cache validator refuses owners nested deeper than sixteen.
  const ownerDepth = (owner: ReceiverOwner | Callee): number =>
    owner.kind === "return" ? 1 + ownerDepth(owner.of) : owner.kind === "method" ? 1 + ownerDepth(owner.owner) : owner.kind === "field" || owner.kind === "element" ? 1 + ownerDepth(owner.of) : 0;
  const MAX_OWNER_DEPTH = 12;
  const bounded = (owner: ReceiverOwner | undefined): ReceiverOwner | undefined => owner !== undefined && ownerDepth(owner) > MAX_OWNER_DEPTH ? undefined : owner;
  const returnOwner = (callee: Callee | undefined, awaited = false): ReceiverOwner | undefined => {
    if (callee === undefined) return undefined;
    const owner: ReceiverOwner = awaited ? { kind: "return", of: callee, unwrapped: true } : { kind: "return", of: callee };
    return bounded(owner);
  };
  // `await f()` names the value inside the promise: the callee's unwrapped return type.
  const awaitedCall = (expression: Node | null): Node | null => {
    expression = unwrap(expression);
    if (expression === null || expression.type !== (python ? "await" : "await_expression")) return null;
    const inner = unwrap(childrenOf(expression).find((child) => child.isNamed) ?? null);
    return inner !== null && inner.type === (python ? "call" : "call_expression") ? inner : null;
  };
  const normalize = (binding: EdgeBinding | undefined): EdgeBinding | undefined => {
    const created = binding === undefined ? undefined : constructions.get(binding);
    if (created === undefined) return binding;
    const owner = symbolBinding(created.expression, created.site);
    if (owner !== undefined && (!created.call || (python && created.awaited !== true))) return { kind: "instance", owner, basis: "constructor" };
    if (!created.call) return { kind: "blocked", reason: "unknown-receiver" };
    const produced = returnOwner(calleeOf(created.expression, created.site), created.awaited);
    return produced === undefined ? { kind: "blocked", reason: "unknown-receiver" } : { kind: "instance", owner: produced, basis: "return" };
  };
  // The owner of a receiver expression: `this`/`self`, a bound instance, a call result, or a field of one of those.
  // A field's declared type is looked up on the holder at resolution time, so the holder may live in another file.
  const chainOwner = (expression: Node | null, site: Node, member: string): ReceiverOwner | undefined => {
    expression = unwrap(expression);
    if (expression === null) return undefined;
    if (!python && expression.type === "this") {
      const receiver = thisFor(scopes.get(site.id) ?? module);
      return receiver === null || receiver === undefined || receiver.mode !== "instance" || mutated(receiver, member) ? undefined : receiver.owner;
    }
    if (expression.type === "identifier") {
      const binding = normalize(lookup(expression.text, site));
      return binding?.kind === "instance" && !mutated(binding, member) ? binding.owner : undefined;
    }
    if (expression.type === (python ? "call" : "call_expression")) {
      const constructed = python ? symbolBinding(expression.childForFieldName("function"), site) : undefined;
      return constructed ?? returnOwner(calleeOf(expression.childForFieldName("function"), site));
    }
    const awaited = awaitedCall(expression);
    if (awaited !== null) return returnOwner(calleeOf(awaited.childForFieldName("function"), site), true);
    if (expression.type === "member_expression" || expression.type === "attribute") {
      const field = expression.childForFieldName(python ? "attribute" : "property")?.text;
      const base = field === undefined ? undefined : chainOwner(expression.childForFieldName("object"), site, field);
      return base === undefined || field === undefined ? undefined : bounded({ kind: "field", of: base, member: field });
    }
    return undefined;
  };
  const at = (expression: Node | null, site: Node): EdgeBinding | undefined => {
      expression = unwrap(expression);
      if (expression?.type === "identifier") return normalize(lookup(expression.text, site)) ?? { kind: "blocked", reason: ambient.has(expression.text) ? "unsupported" : "unbound" };
      if (expression !== null && ["member_expression", "attribute"].includes(expression.type)) {
        const object = unwrap(expression.childForFieldName("object"));
        const property = expression.childForFieldName(python ? "attribute" : "property");
        if (property === null) return { kind: "blocked", reason: "unknown-receiver" };
        // super.m() (TypeScript) and super().m() (Python) name the parent class of the enclosing class.
        const superCall = python && object?.type === "call" && object.childForFieldName("function")?.text === "super" && lookup("super", site) === undefined;
        if (object?.type === "super" || superCall) {
          const owner = python ? classOf(scopes.get(site.id) ?? module) : thisFor(scopes.get(site.id) ?? module)?.classScope ?? null;
          return owner === null || owner === undefined ? { kind: "blocked", reason: "unknown-receiver" } : { kind: "member", owner: { kind: "super", of: { kind: "local", name: owner.owner } }, member: property.text, mode: "instance", basis: "lexical" };
        }
        if (object?.type === "this") {
          const receiver = thisFor(scopes.get(site.id) ?? module);
          return receiver === null || receiver === undefined || mutated(receiver, property.text) ? { kind: "blocked", reason: "unknown-receiver" }
            : { kind: "member", owner: receiver.owner, member: property.text, mode: receiver.mode, basis: "lexical" };
        }
        if (object !== null && ["member_expression", "attribute"].includes(object.type)) {
          const inner = unwrap(object.childForFieldName("object"));
          const field = object.childForFieldName(python ? "attribute" : "property")?.text;
          const siteScope = scopes.get(site.id) ?? module;
          if (!python && inner?.type === "identifier" && field !== undefined) {
            const head = lookup(inner.text, site);
            if (head?.kind === "local" && !mutated(head, field)) return { kind: "member", owner: { kind: "local", name: `${head.name}.${field}` }, member: property.text, mode: "class", basis: "class-reference" };
          }
          let cls: Scope | null = null;
          if (!python && inner?.type === "this") { const self = thisFor(siteScope); cls = self?.mode === "instance" ? self.classScope ?? null : null; }
          else if (python && inner?.type === "identifier") {
            const fn = nearestFunction(siteScope);
            const self = fn.names.get(inner.text)?.[0];
            if (self?.kind === "instance" && self.basis === "lexical" && fn.names.get(inner.text)?.length === 1) cls = classOf(siteScope);
          }
          if (cls !== null && field !== undefined) {
            const writes = cls.fieldWrites?.get(field) ?? 0;
            const annotated = cls.fields?.get(field);
            if (annotated !== undefined && writes <= 1) {
              const owner = annotated.typeName === THIS_TYPE ? { kind: "local" as const, name: cls.owner } : ownerFor(annotated.typeName, annotated.site);
              if (owner !== undefined) return { kind: "member", owner, member: property.text, mode: "instance", basis: "annotation" };
            }
            const constructed = cls.constructorFields?.get(field);
            if (constructed !== undefined && writes === 1) {
              const owner = ownerFor(constructed.typeName, constructed.site, true);
              if (owner !== undefined) return { kind: "member", owner, member: property.text, mode: "instance", basis: "constructor" };
            }
            if (writes > 1) return { kind: "blocked", reason: "unknown-receiver" };
          }
          const chained = chainOwner(object, site, property.text);
          if (chained !== undefined) return { kind: "member", owner: chained, member: property.text, mode: "instance", basis: "annotation" };
        }
        if (object !== null && object.type === (python ? "call" : "call_expression")) {
          const fn = unwrap(object.childForFieldName("function"));
          const known = fn !== null && (fn.type === "member_expression" || fn.type === "attribute") && fn.childForFieldName(python ? "attribute" : "property")?.text === "get" ? knownContents(fn.childForFieldName("object"), site, "value") : undefined;
          if (known !== undefined) return { kind: "member", owner: known, member: property.text, mode: "instance", basis: "annotation" };
        }
        if (object !== null && object.type === (python ? "call" : "call_expression") && (python ? symbolBinding(object.childForFieldName("function"), site) === undefined : true)) {
          const owner = returnOwner(calleeOf(object.childForFieldName("function"), site));
          return owner === undefined ? { kind: "blocked", reason: "unknown-receiver" } : { kind: "member", owner, member: property.text, mode: "instance", basis: "return" };
        }
        if (object !== null && (object.type === "subscript_expression" || object.type === "subscript")) {
          const owner = elementOwnerOf(object.childForFieldName(python ? "value" : "object"), site, "either");
          return owner === undefined ? { kind: "blocked", reason: "unknown-receiver" } : { kind: "member", owner, member: property.text, mode: "instance", basis: "annotation" };
        }
        const awaited = awaitedCall(object);
        if (awaited !== null) {
          const owner = returnOwner(calleeOf(awaited.childForFieldName("function"), site), true);
          return owner === undefined ? { kind: "blocked", reason: "unknown-receiver" } : { kind: "member", owner, member: property.text, mode: "instance", basis: "return" };
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
  };
  const ownYield = (node: Node): boolean => childrenOf(node).some((child) =>
    child.type === "yield" || (!["function_definition", "class_definition", "lambda"].includes(child.type) && ownYield(child)));
  const isTypingSelf = (inner: Node): boolean => {
    const parts = inner.text.split(".");
    if (parts.length > 2) return false;
    const [head, member] = parts;
    if (head === undefined) return false;
    const binding = lookup(head, inner);
    if (binding?.kind !== "import" || !["typing", "typing_extensions"].includes(binding.source)) return false;
    return member === undefined ? binding.importedName === "Self" : member === "Self" && binding.importedName === "*";
  };
  const returns = (node: Node): ReturnBinding | undefined => {
    if (python) {
      const type = node.childForFieldName("return_type");
      if (type === null) return undefined;
      if (node.children.some((child) => child?.type === "async")) return undefined;
      const body = node.childForFieldName("body");
      if (body !== null && ownYield(body)) return undefined;
      const inner = type.type === "type" ? childrenOf(type)[0] ?? null : type;
      if (inner === null) return undefined;
      if ((inner.type === "identifier" || inner.type === "attribute") && isTypingSelf(inner)) return classOf(scopes.get(node.id) ?? module) === null ? undefined : { kind: "this" };
      const name = pythonTypeName(inner);
      return name === undefined ? undefined : ownerFor(name, node);
    }
    if (node.children.some((child) => child?.type === "async") || node.type === "generator_function_declaration" || node.type === "generator_function" || node.children.some((child) => child?.type === "*")) return undefined;
    let holder: Node = node;
    if (node.type === "property_signature") {
      const fn = childrenOf(node.childForFieldName("type") ?? node).find((child) => child.type === "function_type");
      if (fn === undefined) return undefined;
      holder = fn;
    }
    const type = holder.childForFieldName("return_type");
    if (type === null) return undefined;
    const inner = type.type === "type_annotation" ? childrenOf(type).find((child) => child.type !== ":") ?? null : type;
    if (inner?.type === "this_type") return { kind: "this" };
    const name = annotationTypeName(inner);
    return name === undefined ? undefined : ownerFor(name, node);
  };
  // The value type inside a wrapper: `Promise<Foo>` (or an async function's declared result in Python) is a Foo once awaited.
  const unwrapped = (node: Node): ReturnBinding | undefined => {
    if (python) {
      const type = node.childForFieldName("return_type");
      if (type === null || !node.children.some((child) => child?.type === "async")) return undefined;
      const body = node.childForFieldName("body");
      if (body !== null && ownYield(body)) return undefined;
      const inner = type.type === "type" ? childrenOf(type)[0] ?? null : type;
      if (inner !== null && (inner.type === "identifier" || inner.type === "attribute") && isTypingSelf(inner)) return classOf(scopes.get(node.id) ?? module) === null ? undefined : { kind: "this" };
      const name = pythonTypeName(inner);
      return name === undefined ? undefined : ownerFor(name, node);
    }
    if (node.type === "generator_function_declaration" || node.type === "generator_function" || node.children.some((child) => child?.type === "*")) return undefined;
    const type = node.childForFieldName("return_type");
    const annotation = type === null ? null : type.type === "type_annotation" ? childrenOf(type).find((child) => child.type !== ":") ?? null : type;
    if (annotation?.type !== "generic_type") return undefined;
    const base = childrenOf(annotation)[0];
    if (base === undefined || base.type !== "type_identifier" || (base.text !== "Promise" && base.text !== "PromiseLike")) return undefined;
    const argument = childrenOf(childrenOf(annotation).find((child) => child.type === "type_arguments") ?? annotation).find((child) => child.isNamed);
    if (argument === undefined) return undefined;
    if (argument.type === "this_type") return { kind: "this" };
    const name = annotationTypeName(argument);
    return name === undefined ? undefined : ownerFor(name, node);
  };
  // What a returned collection holds: `(): Foo[]` and `-> list[Foo]` produce Foos, `(): Map<K, Foo>` holds Foos as values.
  const returnedContents = (node: Node): { element?: ReturnBinding | undefined; value?: ReturnBinding | undefined } => {
    if (node.children.some((child) => child?.type === "async") || node.type === "generator_function_declaration" || node.type === "generator_function" || node.children.some((child) => child?.type === "*")) return {};
    const type = node.childForFieldName("return_type");
    if (type === null) return {};
    if (python) {
      const body = node.childForFieldName("body");
      if (body !== null && ownYield(body)) return {};
    }
    const contents = python ? pythonContentTypeNames(type) : contentTypeNames(type);
    return { element: contents?.element === undefined ? undefined : ownerFor(contents.element, node), value: contents?.value === undefined ? undefined : ownerFor(contents.value, node) };
  };
  // Python binds names in execution order: a module-level rebinding of `property` after the class
  // does not change a decorator evaluated before it.
  const moduleBindsBefore = (name: string, position: number): boolean => {
    const binds = (node: Node): boolean => {
      if (node.startIndex >= position) return false;
      if (node.type === "function_definition" || node.type === "class_definition") return node.childForFieldName("name")?.text === name;
      if (node.type === "decorated_definition") return node.childForFieldName("definition")?.childForFieldName("name")?.text === name;
      if (node.type === "lambda") return false;
      if (node.type === "assignment" || node.type === "augmented_assignment" || node.type === "named_expression") return patternNames(node.childForFieldName("left") ?? node.childForFieldName("name")).includes(name);
      if (node.type === "for_statement") return patternNames(node.childForFieldName("left")).includes(name) || childrenOf(node).some(binds);
      if (node.type === "as_pattern") return patternNames(node.childForFieldName("alias") ?? childrenOf(node)[1] ?? null).includes(name);
      if (node.type === "import_from_statement") {
        if (childrenOf(node).some((child) => child.type === "wildcard_import")) return true;
        const source = node.childForFieldName("module_name");
        return childrenOf(node).some((item) => item.id !== source?.id && item.type !== "relative_import" &&
          (item.type === "aliased_import" ? item.childForFieldName("alias")?.text : item.text) === name);
      }
      if (node.type === "import_statement") return childrenOf(node).some((item) =>
        (item.type === "aliased_import" ? item.childForFieldName("alias")?.text : item.text.split(".")[0]) === name);
      return childrenOf(node).some(binds);
    };
    return childrenOf(root).some(binds);
  };
  for (const pending of pendingProperties) {
    const bound = lookup("property", pending.decorator);
    if (bound !== undefined && (!module.names.has("property") || moduleBindsBefore("property", pending.decorator.startIndex))) continue;
    pending.fields.set(pending.name, { typeName: isTypingSelf(pending.inner) ? THIS_TYPE : pending.inner.text, site: pending.decorator });
  }
  const contentTable = (node: Node, which: "element" | "value"): Record<string, SymbolBinding> | undefined => {
    const out: Record<string, SymbolBinding> = {};
    const scope = scopes.get(node.id);
    if (scope?.kind === "class") {
      for (const [name, field] of scope.fields ?? []) {
        const typeName = field.contents?.[which];
        const owner = typeName === undefined ? undefined : ownerFor(typeName, field.site);
        if (owner !== undefined) out[name] = owner;
      }
    } else if (!python && node.type === "interface_declaration") {
      for (const member of childrenOf(node.childForFieldName("body") ?? node)) {
        if (member.type !== "property_signature") continue;
        const name = member.childForFieldName("name");
        const typeName = contentTypeNames(member.childForFieldName("type"))?.[which];
        const owner = typeName === undefined ? undefined : ownerFor(typeName, node);
        if (name?.type === "property_identifier" && owner !== undefined) out[name.text] = owner;
      }
    }
    return Object.keys(out).length === 0 ? undefined : out;
  };
  // The element of an iterated expression: a collection binding with a recorded element, or the
  // element of a field, call result or instance whose holder records one.
  // A collection bound in this file with a recorded element or value type: `xs: Foo[]`, `m: Map<string, Foo>`.
  const knownContents = (expression: Node | null, site: Node, mode?: "value" | "either"): SymbolBinding | undefined => {
    expression = unwrap(expression);
    if (expression?.type !== "identifier") return undefined;
    const binding = normalize(lookup(expression.text, site));
    const known = binding === undefined ? undefined : contentsOf.get(binding);
    if (known === undefined || mutated(binding, "*")) return undefined;
    return mode === "value" ? known.value : mode === "either" ? known.value ?? known.element : known.element;
  };
  const BUILTIN_PASS_THROUGH = new Set(["filter", "slice", "concat", "reverse", "sort", "toSorted", "toReversed"]);
  const elementOwnerOf = (expression: Node | null, site: Node, mode?: "value" | "either"): ReceiverOwner | undefined => {
    expression = unwrap(expression);
    if (expression === null) return undefined;
    if (expression.type === (python ? "call" : "call_expression")) {
      const fn = unwrap(expression.childForFieldName("function"));
      if (fn !== null && (fn.type === "member_expression" || fn.type === "attribute")) {
        const member = fn.childForFieldName(python ? "attribute" : "property")?.text ?? "";
        const known = member === "values" ? knownContents(fn.childForFieldName("object"), site, "either") : BUILTIN_PASS_THROUGH.has(member) ? knownContents(fn.childForFieldName("object"), site, mode) : undefined;
        if (known !== undefined) return known;
      }
    }
    if (expression.type === "identifier") {
      const known = knownContents(expression, site, mode);
      if (known !== undefined) return known;
      const binding = normalize(lookup(expression.text, site));
      return binding?.kind === "instance" && !mutated(binding, "*") ? bounded({ kind: "element", of: binding.owner, ...(mode === undefined ? {} : { mode }) }) : undefined;
    }
    if (expression.type === (python ? "call" : "call_expression")) {
      const owner = returnOwner(calleeOf(expression.childForFieldName("function"), site));
      return owner === undefined ? undefined : bounded({ kind: "element", of: owner, ...(mode === undefined ? {} : { mode }) });
    }
    const owner = chainOwner(expression, site, "");
    return owner === undefined ? undefined : bounded({ kind: "element", of: owner, ...(mode === undefined ? {} : { mode }) });
  };
  const flows: Array<{ kind: "loop"; item: (typeof loops)[number] } | { kind: "alias"; item: (typeof aliases)[number] }> = [
    ...loops.map((item) => ({ kind: "loop" as const, item })), ...aliases.map((item) => ({ kind: "alias" as const, item }))].sort((a, b) => a.item.site.startIndex - b.item.site.startIndex);
  for (const flow of flows) {
    const { scope, name, site } = flow.item;
    const current = scope.names.get(name);
    if (current === undefined || current.length === 0 || !current.every((binding) => binding === localValue)) continue;
    const owner = flow.kind === "loop" ? elementOwnerOf(flow.item.source, site, flow.item.mode)
      : flow.item.value.type === "subscript_expression" || flow.item.value.type === "subscript" ? elementOwnerOf(flow.item.value.childForFieldName(python ? "value" : "object"), site, "either")
      : chainOwner(flow.item.value, site, "");
    if (owner === undefined || reassigns(enclosingBody(site, root), name, site.id)) continue;
    scope.names.set(name, [{ kind: "instance", owner, basis: "annotation" }]);
  }
  return {
    at,
    returns,
    heritage: (node) => {
      const out: SymbolBinding[] = [];
      const push = (text: string | undefined) => { if (text === undefined) return; const owner = ownerFor(text, node); if (owner !== undefined && !out.some((item) => canonical(item) === canonical(owner))) out.push(owner); };
      if (python) {
        for (const arg of childrenOf(node.childForFieldName("superclasses") ?? node)) {
          if (arg.type === "identifier" || arg.type === "attribute") push(arg.text);
        }
        return out;
      }
      for (const clause of childrenOf(node.type === "class_declaration" || node.type === "abstract_class_declaration" ? childOfType(node, "class_heritage") ?? node : node)) {
        if (clause.type === "extends_clause" || clause.type === "extends_type_clause") {
          for (const item of childrenOf(clause)) {
            if (["identifier", "member_expression", "type_identifier", "nested_type_identifier"].includes(item.type)) push(item.text);
            if (item.type === "generic_type") { const base = childrenOf(item)[0]; if (base !== undefined && ["type_identifier", "nested_type_identifier"].includes(base.type)) push(base.text); }
          }
        }
      }
      return out;
    },
    unwrapped,
    elements: (node) => returnedContents(node).element,
    values: (node) => returnedContents(node).value,
    elementTypes: (node) => contentTable(node, "element"),
    valueTypes: (node) => contentTable(node, "value"),
    fieldTypes: (node) => {
      const out: Record<string, SymbolBinding> = {};
      const scope = scopes.get(node.id);
      if (scope?.kind === "class") {
        for (const [name, field] of scope.fields ?? []) {
          const owner = field.typeName === THIS_TYPE ? { kind: "local" as const, name: scope.owner } : ownerFor(field.typeName, field.site);
          if (owner !== undefined) out[name] = owner;
        }
        for (const [name, field] of scope.constructorFields ?? []) {
          if (name in out || (scope.fieldWrites?.get(name) ?? 0) !== 1) continue;
          const owner = ownerFor(field.typeName, field.site, true);
          if (owner !== undefined) out[name] = owner;
        }
      } else if (!python && node.type === "interface_declaration") {
        for (const member of childrenOf(node.childForFieldName("body") ?? node)) {
          if (member.type !== "property_signature") continue;
          const name = member.childForFieldName("name");
          const typeName = annotationTypeName(member.childForFieldName("type"));
          const owner = typeName === undefined ? undefined : ownerFor(typeName, node);
          if (name?.type === "property_identifier" && owner !== undefined) out[name.text] = owner;
        }
      }
      return Object.keys(out).length === 0 ? undefined : out;
    },
    ownFields: (node) => {
      const out = new Set<string>();
      for (const member of childrenOf(node.childForFieldName("body") ?? node)) {
        if (python) {
          const assignment = member.type === "expression_statement" ? childrenOf(member)[0] : null;
          const left = assignment?.type === "assignment" ? assignment.childForFieldName("left") : null;
          if (left?.type === "identifier") out.add(left.text);
        } else if (FIELD_NODES.has(member.type)) {
          const value = member.childForFieldName("value");
          const name = fieldNameOf(member);
          if (name?.type === "property_identifier" && (value === null || !FUNCTION_VALUE_NODES.has(value.type))) out.add(name.text);
        }
      }
      return [...out].sort();
    },
    exportedNames: (name, parent) => parent !== "" || module.names.has("*") ? [] : python ? [name] : [...(exports.get(name)?.keys() ?? [])].sort(),
    reExports,
    memberKind,
  };
}
