import type { Node } from "web-tree-sitter";
import { Extractor, argumentCount, childOfType, childrenOf, withoutTypeArguments } from "./util.js";
import type { AdapterOutput, LanguageAdapter } from "./adapter.js";
import type { ParameterRange } from "../types.js";
import { collectTypedBindings, csharpSpec } from "./typed-bindings.js";

// A C# identifier after `plain`: a letter or underscore, then letters, digits, marks and connectors.
const IDENTIFIER_RE = /^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]*$/u;

// This grammar writes `params int[] rest` as a bare `params` token in the list, not as a parameter.
// A method a derived type cannot call: written `private`, or without an access modifier outside an interface.
function accessOf(method: Node): ParameterRange["access"] {
  const modifiers = new Set(childrenOf(method).filter((child) => child.type === "modifier").map((child) => child.text));
  if (modifiers.has("private") && !modifiers.has("protected")) return "private";
  if (["public", "protected", "internal", "private"].some((name) => modifiers.has(name))) return undefined;
  return method.parent?.parent?.type === "interface_declaration" ? undefined : "private";
}

function parameterRange(list: Node, method: Node, constructor = false): ParameterRange {
  const overrides = childrenOf(method).some((child) => child.type === "modifier" && child.text === "override");
  const access = accessOf(method);
  let required = 0;
  let optional = 0;
  const variadic = list.children.some((child) => child?.type === "params");
  let extension = false;
  for (const child of childrenOf(list)) {
    if (child.type !== "parameter") continue;
    if (required + optional === 0 && childrenOf(child).some((part) => part.type === "parameter_modifier" && part.text === "this")) extension = true;
    if (childOfType(child, "equals_value_clause") !== null) optional += 1;
    else required += 1;
  }
  return { min: required, ...(variadic ? {} : { max: required + optional }), ...(extension ? { extension: true as const } : {}), ...(overrides ? { overrides: true as const } : {}), ...(access === undefined ? {} : { access }), ...(constructor ? { constructs: true as const } : {}) };
}

// One C# identifier however it is spelled, as the compiler compares them: `@class` is `class`, a `\u0041` escape is `A`,
// and formatting characters (such as U+200C) are not part of the name.
const plain = (identifier: string): string => identifier
  .replace(/\\u([0-9A-Fa-f]{4})|\\U([0-9A-Fa-f]{8})/g, (_, short: string | undefined, long: string | undefined) => String.fromCodePoint(parseInt(short ?? long!, 16)))
  .replace(/^@/, "")
  .replace(/\p{Cf}/gu, "");

// A written type name with each segment's generic arity: `Outer<int>.Inner` is ``Outer`1.Inner``, and
// `global::N.T` keeps its `global::` qualifier.
function aritiedName(type: Node): string {
  const parts = childrenOf(type).filter((child) => child.type !== "comment");
  if (type.type === "generic_name") {
    const name = parts.find((child) => child.type === "identifier");
    const list = parts.find((child) => child.type === "type_argument_list");
    const arity = list === undefined ? 0 : childrenOf(list).filter((child) => child.type !== "comment").length;
    return name === undefined ? withoutTypeArguments(type.text) : arity === 0 ? plain(name.text) : `${plain(name.text)}\`${arity}`;
  }
  if (type.type === "qualified_name") return parts.map(aritiedName).join(".");
  // Only the keyword `global` itself names the global namespace; `@global` or a respelled `global` is an alias, kept
  // marked with `@` so that it is never read as the keyword.
  if (type.type === "alias_qualified_name") {
    const [qualifier, ...rest] = parts;
    const alias = qualifier === undefined ? "" : qualifier.text === "global" ? "global" : `@${plain(qualifier.text)}`;
    return [alias, ...rest.map(aritiedName)].join("::");
  }
  if (type.type === "identifier") return plain(type.text);
  return withoutTypeArguments(type.text);
}

// A namespace name read from its identifiers, past comments and `@`: `A /* c */ . @B` is `A.B`.
function namespaceName(name: Node): string {
  if (name.type === "identifier") return plain(name.text);
  return childrenOf(name).filter((child) => child.type !== "comment").map(namespaceName).join(".");
}

// Whether a derived type or a static import can see a member type: `private` (written so, or with no access
// modifier in a class or struct), `protected` (only from derived types, `private protected` included), or neither.
function memberTypeAccess(type: Node): "private" | "protected" | undefined {
  const modifiers = new Set(childrenOf(type).filter((child) => child.type === "modifier").map((child) => child.text));
  if (modifiers.has("private")) return modifiers.has("protected") ? "protected" : "private";
  if (modifiers.has("protected")) return modifiers.has("internal") ? undefined : "protected";
  if (modifiers.has("public") || modifiers.has("internal")) return undefined;
  return type.parent?.parent?.type === "interface_declaration" ? undefined : "private";
}

// The byte ranges from each `#if` to its `#endif` (or the end of the file), in document order.
function conditionalRegions(root: Node): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  const open: number[] = [];
  const pending: Node[] = [root];
  const directives: Node[] = [];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.type === "if_directive" || node.type === "endif_directive") directives.push(node);
    for (let index = node.childCount - 1; index >= 0; index -= 1) {
      const child = node.child(index);
      if (child !== null) pending.push(child);
    }
  }
  for (const directive of directives.sort((a, b) => a.startIndex - b.startIndex)) {
    if (directive.type === "if_directive") open.push(directive.startIndex);
    else if (open.length > 0) regions.push([open.pop()!, directive.endIndex]);
  }
  for (const start of open) regions.push([start, root.endIndex]);
  return regions;
}

// Whether a parse error swallowed a `namespace` keyword or an identifier escape (`\u0050`), which the bundled grammar
// cannot read in a name.
function parseLostScope(root: Node): boolean {
  if (!root.hasError) return false;
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.type === "ERROR" && node.children.some((child) => child !== null && (child.type === "namespace" || child.type === "escape_sequence"))) return true;
    for (const child of node.children) if (child !== null && child.hasError) pending.push(child);
  }
  return false;
}

// Whether an enclosing declaration (a type, method or local function) declares a type parameter of this name.
function typeParameterInScope(node: Node, name: string): boolean {
  for (let scope = node.parent; scope !== null; scope = scope.parent) {
    const list = childOfType(scope, "type_parameter_list");
    if (list !== null && childrenOf(list).some((parameter) => parameter.type === "type_parameter" && childrenOf(parameter).some((child) => child.type === "identifier" && plain(child.text) === plain(name)))) return true;
  }
  return false;
}

// A parameter list written after the type's name and type parameters: a record's, or a class's or struct's
// primary constructor (C# 12), which the recovery parse leaves out of the tree but not out of the node's text.
function hasPrimaryConstructor(type: Node, name: Node): boolean {
  if (childOfType(type, "parameter_list") !== null) return true;
  const after = childOfType(type, "type_parameter_list") ?? name;
  return /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*\(/.test(type.text.slice(after.endIndex - type.startIndex));
}

export const csharpAdapter: LanguageAdapter = {
  language: "c_sharp",
  extract(tree, source): AdapterOutput {
    const out = new Extractor();
    // A namespace header or an escaped identifier the grammar could not read leaves the file's namespaces unknown, so no
    // creation in it can be bound by scope.
    const scopeLost = parseLostScope(tree.rootNode);
    // The byte ranges of `#if` regions, whose declarations and directives may not be compiled.
    // Most files have none, so the tree is walked for them only when a line starts with `#if` (spaces and tabs allowed
    // around the `#`).
    const regions = /^[ \t]*#[ \t]*if\b/mu.test(source) ? conditionalRegions(tree.rootNode) : [];
    const conditional = (node: Node): boolean => regions.some(([from, to]) => node.startIndex >= from && node.startIndex <= to);
    // A declaration header (before the body) that holds an `#if` region may write a base or type parameters that are
    // not compiled.
    const conditionalHeader = (node: Node): boolean => {
      const end = (node.childForFieldName("body") ?? childOfType(node, "declaration_list"))?.startIndex ?? node.endIndex;
      return regions.some(([from, to]) => from <= end && to >= node.startIndex);
    };
    const bindings = collectTypedBindings(tree.rootNode, csharpSpec);

    const namespaces: string[] = [];
    // The line range of each enclosing namespace declaration, which bounds the using directives declared in it.
    const blocks: string[] = [];
    // The generic arity of each enclosing type, outermost first: `Outer<T>.Inner` and `Outer<T, U>.Inner`
    // are different types with the same local name.
    const arities: number[] = [];
    const visit = (node: Node): void => {
      switch (node.type) {
        case "namespace_declaration":
        case "file_scoped_namespace_declaration": {
          const name = node.childForFieldName("name");
          if (name !== null) {
            namespaces.push(namespaceName(name));
            blocks.push(`${node.startPosition.row + 1}-${node.endPosition.row + 1}`);
          }
          for (const child of childrenOf(node)) visit(child);
          if (name !== null) {
            namespaces.pop();
            blocks.pop();
          }
          return;
        }
        case "class_declaration":
        case "interface_declaration":
        case "struct_declaration":
        case "enum_declaration":
        case "record_declaration":
        case "record_struct_declaration": {
          const nameNode = node.childForFieldName("name");
          if (nameNode === null || !IDENTIFIER_RE.test(plain(nameNode.text))) return;
          const typeName = plain(nameNode.text);
          const kind =
            node.type === "interface_declaration"
              ? "interface"
              : node.type === "enum_declaration"
                ? "enum"
                : node.type === "struct_declaration" || node.type === "record_struct_declaration"
                  ? "struct"
                  : "class";
          out.addDef(typeName, kind, node, undefined, undefined, node.type === "class_declaration" || node.type === "record_declaration" || node.type === "record_struct_declaration" ? bindings.heritage(node) : undefined, undefined, undefined, undefined, bindings.fieldTypes(childrenOf(node.childForFieldName("body") ?? node)), undefined, undefined, bindings.elementTypes(childrenOf(node.childForFieldName("body") ?? node)), undefined, bindings.valueTypes(childrenOf(node.childForFieldName("body") ?? node)));
          arities.push(childrenOf(childOfType(node, "type_parameter_list") ?? node).filter((child) => child.type === "type_parameter").length);
          if (hasPrimaryConstructor(node, nameNode)) out.markPrimary();
          if (arities[arities.length - 1]! > 0) out.markArity(arities[arities.length - 1]!);
          // A top-level type records its namespace; a member type records whether a derived type can see it.
          // In a file whose namespace header was lost, a top-level type's namespace is unknown (`?`).
          if (arities.length === 1 && (scopeLost || namespaces.length > 0)) out.markNamespace(scopeLost ? "?" : namespaces.join("."));
          const access = arities.length > 1 ? memberTypeAccess(node) : undefined;
          if (access !== undefined) out.markAccess(access);
          // The first base as written, which a class inherits member types from; an interface inherits them from
          // every base, which this one name cannot hold, so several are recorded as unknown (`?`).
          // A base written with constructor arguments (`record C(int x) : B(x)`) names its type inside the wrapper; a first
          // base written any other way the index cannot read is recorded as unknown rather than as none.
          const bases = childrenOf(childOfType(node, "base_list") ?? node).filter((child) => child.type !== "comment")
            .map((child) => child.type === "primary_constructor_base_type" ? childrenOf(child).find((part) => part.type !== "comment" && part.type !== "argument_list") ?? child : child);
          const readable = (base: Node): boolean => ["identifier", "generic_name", "qualified_name", "alias_qualified_name"].includes(base.type);
          // A parse error in the declaration's header can hide or garble its base (`record C(int x) : P.B(x)`), so the
          // base is unknown. An enum's base is its underlying integral type, which holds no member types.
          const headerBroken = childrenOf(node).some((child) => child.type === "ERROR" || (child.type === "base_list" && child.hasError));
          if (headerBroken) out.markUnparsedHeader();
          if (conditional(node) || conditionalHeader(node)) out.markConditional();
          if (node.type !== "enum_declaration" && headerBroken) out.markBaseType("?");
          else if (node.type !== "enum_declaration" && childOfType(node, "base_list") !== null) {
            if (node.type === "interface_declaration" && bases.length > 1) out.markBaseType("?");
            else if (bases[0] !== undefined) out.markBaseType(readable(bases[0]) ? aritiedName(bases[0]) : "?");
          }
          if (childrenOf(node).some((child) => child.type === "modifier" && child.text === "partial")) out.markPartial(`${namespaces.join(".")}\`${arities.join(".")}`);
          out.push(typeName);
          for (const child of childrenOf(node)) visit(child);
          out.pop();
          arities.pop();
          return;
        }
        case "delegate_declaration": {
          // A delegate is a type, so it hides a same-named type further out, though its constructor is not indexed.
          const nameNode = node.childForFieldName("name");
          if (nameNode === null || !IDENTIFIER_RE.test(plain(nameNode.text))) return;
          out.addDef(plain(nameNode.text), "type", node);
          const arity = childrenOf(node.childForFieldName("type_parameters") ?? node).filter((child) => child.type === "type_parameter").length;
          if (arity > 0) out.markArity(arity);
          if (arities.length === 0 && (scopeLost || namespaces.length > 0)) out.markNamespace(scopeLost ? "?" : namespaces.join("."));
          const access = arities.length > 0 ? memberTypeAccess(node) : undefined;
          if (access !== undefined) out.markAccess(access);
          if (conditional(node)) out.markConditional();
          return;
        }
        case "method_declaration":
        case "constructor_declaration": {
          const nameNode = node.childForFieldName("name");
          if (nameNode !== null && IDENTIFIER_RE.test(plain(nameNode.text))) {
            out.addDef(plain(nameNode.text), "method", node, undefined, bindings.memberKind(node), undefined, undefined, bindings.returns(node), undefined, undefined, undefined, bindings.elements(node), undefined, bindings.values(node));
            const parameters = node.childForFieldName("parameters");
            if (parameters !== null) out.setParameters(parameterRange(parameters, node, node.type === "constructor_declaration" && !childrenOf(node).some((child) => child.type === "modifier" && child.text === "static")));
            // A constructor inside an `#if` region may not be compiled, which changes the constructors a creation can run.
            if (node.type === "constructor_declaration" && conditional(node)) out.markConditional();
            out.push(plain(nameNode.text));
            for (const child of childrenOf(node)) visit(child);
            out.pop();
          }
          return;
        }
        case "field_declaration": {
          const modifiers = childOfType(node, "modifiers");
          const isConst = modifiers !== null && /\bconst\b/.test(modifiers.text);
          if (isConst) {
            for (const declarator of childrenOf(node)) {
              if (declarator.type !== "variable_declaration") continue;
              for (const varDeclarator of childrenOf(declarator)) {
                if (varDeclarator.type !== "variable_declarator") continue;
                const nameNode = varDeclarator.childForFieldName("name");
                if (nameNode !== null && /^[A-Z][A-Z0-9_]*$/.test(nameNode.text)) {
                  out.addDef(nameNode.text, "constant", varDeclarator);
                }
              }
            }
          }
          for (const child of childrenOf(node)) visit(child);
          return;
        }
        case "invocation_expression": {
          const fn = node.childForFieldName("function");
          const args = argumentCount(node.childForFieldName("arguments"));
          if (fn !== null) {
            if (fn.type === "identifier") {
              out.addEdge("calls", fn.text, fn, undefined, undefined, args);
            } else if (fn.type === "member_access_expression") {
              const nameNode = fn.childForFieldName("name");
              if (nameNode !== null) out.addEdge("calls", nameNode.text, nameNode, bindings.at(fn, node), undefined, args);
            }
          }
          for (const child of childrenOf(node)) visit(child);
          return;
        }
        case "object_creation_expression": {
          // `new Box<string>(1)` names ``Box`1``: C# tells `Box` from `Box<T>` by arity, so the name carries it as
          // metadata names do. A type parameter in scope (`new T()` under `where T : new()`) names no declared
          // type, so that creation stays a plain call.
          const typeNode = node.childForFieldName("type");
          // `new T { Init = 1 }` without an argument list runs the parameterless constructor.
          const args = node.childForFieldName("arguments");
          if (typeNode !== null) {
            // A type parameter's constructor depends on the type argument, so the call is blocked rather than matched by name.
            if (scopeLost || (typeNode.type === "identifier" && typeParameterInScope(node, typeNode.text))) out.addEdge("calls", typeNode.type === "identifier" ? plain(typeNode.text) : aritiedName(typeNode), typeNode, { kind: "blocked", reason: "unsupported" });
            else out.addEdge("calls", aritiedName(typeNode), typeNode, undefined, undefined, args === null ? 0 : argumentCount(args), "instance");
          }
          for (const child of childrenOf(node)) visit(child);
          return;
        }
        case "using_directive": {
          // An alias directive records its alias name and `=` (`X =`); comments may sit anywhere in the directive.
          const parts = childrenOf(node).filter((child) => child.type !== "comment");
          const alias = parts.find((child) => child.type === "name_equals");
          const aliasName = alias === undefined ? undefined : childrenOf(alias).find((child) => child.type === "identifier");
          // Any other directive records what it imports, as `[global ][static ]Target[ in Namespace@from-to]`: `global`
          // applies it to every file, `static` imports a type's members, and `in` names the namespace declaration it is
          // declared inside, with that declaration's lines, since another declaration of the namespace does not see it.
          const keywords = new Set(node.children.filter((child): child is Node => child !== null && !child.isNamed).map((child) => child.type));
          const target = parts[0] === undefined ? undefined : aritiedName(parts[0]);
          const scope = namespaces.length === 0 ? "" : ` in ${namespaces.join(".")}@${blocks[blocks.length - 1]!}`;
          // A directive inside an `#if` region is marked `#if `, since it may not be compiled.
          const imported = target === undefined ? undefined : `${conditional(node) ? "#if " : ""}${keywords.has("global") ? "global " : ""}${keywords.has("static") ? "static " : ""}${target}${scope}`;
          const name = alias === undefined ? imported : aliasName === undefined ? undefined : `${plain(aliasName.text)} =`;
          if (name !== undefined) out.addEdge("imports", name, node);
          return;
        }
        default: {
          for (const child of childrenOf(node)) visit(child);
        }
      }
    };
    for (const child of childrenOf(tree.rootNode)) visit(child);
    return { definitions: out.definitions, edges: out.edges };
  },
};
