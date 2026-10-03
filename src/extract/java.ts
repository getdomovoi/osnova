import type { Node } from "web-tree-sitter";
import { Extractor, argumentCount, childOfType, childrenOf, withoutTypeArguments } from "./util.js";
import type { AdapterOutput, LanguageAdapter } from "./adapter.js";
import type { ArgumentTypes, ParameterRange } from "../types.js";
import { collectTypedBindings, javaSpec } from "./typed-bindings.js";

// `@Override` is optional in Java, so a declaration without it counts as a further overload.
const annotatedOverride = (method: Node): boolean => childrenOf(childOfType(method, "modifiers") ?? method).some((child) =>
  child.type === "marker_annotation" && /^(?:java\.lang\.)?Override$/.test(child.childForFieldName("name")?.text ?? ""));

// A method a derived type cannot call (`private`), or only from the same package (no access modifier, outside an interface).
// The modifiers are read as keyword tokens, so an annotation argument or a comment that spells one does not count.
function accessOf(method: Node): ParameterRange["access"] {
  const modifiers = childOfType(method, "modifiers");
  const words = new Set<string>();
  for (let index = 0; index < (modifiers?.childCount ?? 0); index += 1) {
    const token = modifiers!.child(index);
    if (token !== null && !token.isNamed) words.add(token.type);
  }
  if (words.has("private")) return "private";
  if (words.has("public") || words.has("protected")) return undefined;
  return method.parent?.type === "interface_body" || method.parent?.type === "annotation_type_body" ? undefined : "package";
}

// The bodies whose type declarations are member types; a class declared in a block is a local class.
const MEMBER_PARENTS = new Set(["class_body", "interface_body", "enum_body_declarations", "annotation_type_body"]);

const PRIMITIVES = new Set(["boolean", "byte", "char", "short", "int", "long", "float", "double", "void"]);
const JAVA_LANG = new Set(["Object", "String", "CharSequence", "Number", "Integer", "Long", "Short", "Byte", "Character", "Boolean",
  "Float", "Double", "Void", "Class", "Enum", "Record", "Iterable", "Comparable", "Runnable", "Throwable", "Exception",
  "RuntimeException", "Error", "StringBuilder", "StringBuffer", "Thread", "Cloneable", "AutoCloseable", "Appendable", "Readable",
  "Math", "System", "Process", "ClassLoader", "ThreadLocal", "Iterable", "Override", "Deprecated", "FunctionalInterface",
  "IllegalArgumentException", "IllegalStateException", "NullPointerException", "UnsupportedOperationException",
  "IndexOutOfBoundsException", "ClassCastException", "ArithmeticException", "InterruptedException", "CloneNotSupportedException"]);

// What a written type name can be proved to mean from the file alone.
interface TypeScope {
  readonly packageName: string;
  readonly imports: ReadonlyMap<string, string>;
  readonly open: boolean;
  readonly unproven: ReadonlySet<string>;
}

function typeScopeOf(root: Node): TypeScope {
  let packageName = "";
  const imports = new Map<string, string>();
  const unproven = new Set<string>();
  let open = false;
  for (const child of childrenOf(root)) {
    if (child.type === "package_declaration") packageName = childrenOf(child).find((part) => part.type === "scoped_identifier" || part.type === "identifier")?.text ?? "";
    if (child.type !== "import_declaration") continue;
    const path = childrenOf(child).find((part) => part.type === "scoped_identifier" || part.type === "identifier")?.text ?? "";
    const isStatic = child.children.some((part) => part?.type === "static");
    if (childOfType(child, "asterisk") !== null) open = true;
    else if (isStatic) unproven.add(path.slice(path.lastIndexOf(".") + 1));
    else imports.set(path.slice(path.lastIndexOf(".") + 1), path);
  }
  // A type declared inside another type of this file can share a simple name with a type elsewhere.
  const walk = (node: Node, depth: number): void => {
    for (const child of childrenOf(node)) {
      const declares = /^(?:class|interface|enum|record|annotation_type)_declaration$/.test(child.type);
      if (declares && depth > 0) unproven.add(child.childForFieldName("name")?.text ?? "");
      walk(child, declares ? depth + 1 : depth);
    }
  };
  walk(root, 0);
  return { packageName, imports, open, unproven };
}

const typeParametersOf = (node: Node): string[] => childrenOf(childOfType(node, "type_parameters") ?? node)
  .filter((child) => child.type === "type_parameter").map((child) => childrenOf(child).find((part) => part.type === "type_identifier" || part.type === "identifier")?.text ?? "");

// Each type variable a declaration introduces, with the text of its bound: undefined for none (it erases to Object), null
// for several (`T extends A & B`), since one bound alone would say a type satisfies the variable when it may not.
type Bounds = ReadonlyMap<string, string | undefined | null>;
const typeBoundsOf = (node: Node): Map<string, string | undefined | null> => new Map(childrenOf(childOfType(node, "type_parameters") ?? node)
  .filter((child) => child.type === "type_parameter").map((child) => {
    const name = childrenOf(child).find((part) => part.type === "type_identifier" || part.type === "identifier")?.text ?? "";
    const bound = childOfType(child, "type_bound");
    const types = bound === null ? [] : childrenOf(bound).filter((part) => !COMMENT_NODES.has(part.type));
    return [name, types.length === 0 ? undefined : types.length === 1 ? types[0]!.text : null] as const;
  }));
const COMMENT_NODES = new Set(["comment", "line_comment", "block_comment"]);

// A parameter type with every name replaced by the name it would mean from this file alone: primitives as
// written, a single-type import or java.lang by its full name, a package-qualified name as written, and any
// other simple name by this file's package. A type variable, a nested type of this file, or a name a wildcard
// or static import could supply proves nothing, and then the whole list is left unrecorded. `names` lists the
// simple names read from this file's scope; another file can still shadow them (an inherited nested type, or
// a same-package type over java.lang), so the resolver checks them before it compares types.
function canonicalType(written: string, scope: TypeScope, typeVariables: ReadonlySet<string>, names: Set<string>): string | undefined {
  const text = written.replace(/@[\w.$]+(?:\s*\([^)]*\))?/g, " ").replace(/\s*\.\s*/g, ".");
  let proven = true;
  const canonical = text.replace(/[\p{L}\p{Nl}\p{Sc}\p{Pc}][\p{L}\p{Nl}\p{Sc}\p{Pc}\p{Mn}\p{Mc}\p{Nd}\p{Cf}]*(?:\.[\p{L}\p{Nl}\p{Sc}\p{Pc}][\p{L}\p{Nl}\p{Sc}\p{Pc}\p{Mn}\p{Mc}\p{Nd}\p{Cf}]*)*/gu, (name) => {
    if (PRIMITIVES.has(name) || name === "extends" || name === "super") return name;
    const [first = "", ...rest] = name.split(".");
    const tail = rest.length > 0 ? `.${rest.join(".")}` : "";
    if (typeVariables.has(first) || scope.unproven.has(first)) { proven = false; return name; }
    const imported = scope.imports.get(first);
    if (imported !== undefined) { names.add(first); return `${imported}${tail}`; }
    if (rest.length > 0 && /^\p{Ll}/u.test(first)) return name;
    if (JAVA_LANG.has(first)) { names.add(first); return `java.lang.${name}`; }
    if (scope.open) { proven = false; return name; }
    names.add(first);
    return scope.packageName.length > 0 ? `${scope.packageName}.${name}` : name;
  }).replace(/\s+/g, "");
  return proven ? canonical : undefined;
}

// A written type's erasure, named as `canonicalType` names it: type arguments and annotations dropped, a type variable replaced
// by the erasure of its first bound (`java.lang.Object` when it has none), array dimensions kept. Undefined when a name proves
// nothing (a nested type of this file, a name a wildcard or static import could supply).
function erasedType(written: string, scope: TypeScope, bounds: Bounds, names: Set<string>, depth = 0, unknown: ReadonlySet<string> = new Set()): string | undefined {
  let text = written.replace(/@[\w.$]+(?:\s*\([^)]*\))?/g, " ");
  for (let previous = ""; previous !== text;) { previous = text; text = text.replace(/<[^<>]*>/g, ""); }
  text = text.replace(/\s+/g, "");
  const dimensions = /(?:\[\])*$/.exec(text)?.[0] ?? "";
  const base = text.slice(0, text.length - dimensions.length);
  if (!/^[\p{L}\p{Nl}\p{Sc}\p{Pc}][\p{L}\p{Nl}\p{Sc}\p{Pc}\p{Mn}\p{Mc}\p{Nd}\p{Cf}]*(?:\.[\p{L}\p{Nl}\p{Sc}\p{Pc}][\p{L}\p{Nl}\p{Sc}\p{Pc}\p{Mn}\p{Mc}\p{Nd}\p{Cf}]*)*$/u.test(base)) return undefined;
  if (PRIMITIVES.has(base)) return base === "void" ? undefined : `${base}${dimensions}`;
  if (bounds.has(base)) {
    const bound = bounds.get(base);
    if (bound === null) return undefined;
    if (bound === undefined) return `java.lang.Object${dimensions}`;
    const erased = depth > 8 ? undefined : erasedType(bound, scope, bounds, names, depth + 1, unknown);
    return erased === undefined ? undefined : `${erased}${dimensions}`;
  }
  const canonical = canonicalType(base, scope, unknown, names);
  return canonical === undefined ? undefined : `${canonical}${dimensions}`;
}

function parameterRange(list: Node, method: Node, scope: TypeScope, typeVariables: ReadonlySet<string>): ParameterRange {
  // Only the method's own type variables erase to their bound: a call through a parameterized receiver (`C<Integer>`)
  // substitutes its class's, so those prove nothing.
  const bounds = typeBoundsOf(method);
  const classVariables = new Set([...typeVariables].filter((name) => !bounds.has(name)));
  const overrides = annotatedOverride(method);
  const access = accessOf(method);
  let count = 0;
  let varargs = false;
  const types: (string | undefined)[] = [];
  const names = new Set<string>();
  for (const child of childrenOf(list)) {
    if (child.type === "formal_parameter") count += 1;
    else if (child.type === "spread_parameter") varargs = true;
    else continue;
    const type = child.childForFieldName("type") ?? childrenOf(child).find((part) => part.type !== "modifiers" && part.type !== "variable_declarator" && part.type !== "identifier");
    const dimensions = child.childForFieldName("dimensions")?.text ?? "";
    const canonical = canonicalType(type?.text ?? "", scope, typeVariables, names);
    types.push(canonical === undefined ? undefined : `${canonical}${dimensions.replace(/\s+/g, "")}${child.type === "spread_parameter" ? "..." : ""}`);
  }
  const proven = types.every((type): type is string => type !== undefined);
  // When the written types prove nothing, the erased ones may still tell overloads apart by argument types.
  const erasedNames = new Set<string>();
  const parameters = childrenOf(list).filter((child) => child.type === "formal_parameter" || child.type === "spread_parameter");
  const writtenOf = (child: Node): string => {
    const type = child.childForFieldName("type") ?? childrenOf(child).find((part) => part.type !== "modifiers" && part.type !== "variable_declarator" && part.type !== "identifier");
    return `${type?.text ?? ""}${child.childForFieldName("dimensions")?.text ?? ""}`.replace(/@[\w.$]+(?:\s*\([^)]*\))?/g, " ").replace(/\s+/g, "");
  };
  const written = parameters.map(writtenOf);
  // A type variable of the method's own with no bound, written once among the parameters, fits any type argument.
  const free = (name: string): boolean => bounds.has(name) && bounds.get(name) === undefined &&
    written.reduce((sum, text) => sum + (text.match(new RegExp(`(?<![\\p{L}\\p{N}_$.])${name.replace(/\$/g, "\\$")}(?![\\p{L}\\p{N}_$])`, "gu"))?.length ?? 0), 0) === 1;
  // A parameter type its erasure does not stand for: a type argument other than `?` or a free type variable, or a type
  // variable whose bound is parameterized or is another type variable.
  const inexact = (text: string): boolean => {
    let rest = text;
    for (let previous = ""; previous !== rest;) {
      previous = rest;
      let constrained = false;
      rest = rest.replace(/<([^<>]*)>/gu, (_, list: string) => { if (!list.split(",").every((argument) => argument === "?" || free(argument))) constrained = true; return ""; });
      if (constrained) return true;
    }
    const base = rest.replace(/(?:\[\]|\.\.\.)+$/u, "");
    const bound = bounds.get(base);
    return typeof bound === "string" && (bound.includes("<") || bounds.has(bound.replace(/\s+/g, "").replace(/(?:\[\])+$/u, "")));
  };
  const erased = proven ? [] : parameters.map((child, at) => {
    const dimensions = (child.childForFieldName("dimensions")?.text ?? "").replace(/\s+/g, "");
    const type = child.childForFieldName("type") ?? childrenOf(child).find((part) => part.type !== "modifiers" && part.type !== "variable_declarator" && part.type !== "identifier");
    const one = erasedType(`${type?.text ?? ""}${dimensions}`, scope, bounds, erasedNames, 0, classVariables);
    return one === undefined ? null : `${inexact(written[at]!) ? "~" : ""}${one}${child.type === "spread_parameter" ? "..." : ""}`;
  });
  const keepErased = erased.some((type) => type !== null);
  return { min: count, ...(varargs ? {} : { max: count }), ...(overrides ? { overrides: true as const } : {}), ...(access === undefined ? {} : { access }),
    ...(proven ? { types, ...(names.size > 0 ? { names: [...names].sort() } : {}) } : {}),
    ...(keepErased ? { erased, ...(erasedNames.size > 0 ? { names: [...erasedNames].sort() } : {}) } : {}),
    ...(method.type === "constructor_declaration" ? { constructs: true as const } : {}) };
}

const COMMENTS = new Set(["comment", "line_comment", "block_comment"]);
const NUMERIC_RANK = ["int", "long", "float", "double"];
const UNBOXED: Readonly<Record<string, string>> = { "java.lang.Integer": "int", "java.lang.Long": "long", "java.lang.Short": "short", "java.lang.Byte": "byte",
  "java.lang.Character": "char", "java.lang.Float": "float", "java.lang.Double": "double", "java.lang.Boolean": "boolean" };
// Binary numeric promotion of two operand types, boxed ones unboxed; undefined unless both are numeric.
function promoted(left: string, right: string): string | undefined {
  const rank = (type: string): number => {
    const plain = UNBOXED[type] ?? type;
    return plain === "byte" || plain === "short" || plain === "char" ? 0 : NUMERIC_RANK.indexOf(plain);
  };
  const a = rank(left), b = rank(right);
  return a < 0 || b < 0 ? undefined : NUMERIC_RANK[Math.max(a, b)];
}

// The declared type node of a name the scope holds at `site`: a local declared earlier in an enclosing block, a resource, a
// for or enhanced-for variable, a catch or lambda parameter, a method or constructor parameter, or a field or record
// component of an enclosing class. `null` means the name is declared but its type is not written (`var`, an untyped lambda
// parameter, a multi-catch, a pattern variable) or it may be an inherited field; undefined means no declaration was found.
type Declared = { readonly type: Node; readonly dimensions: string; readonly varargs: boolean; readonly initializer?: Node | undefined } | null;
function declaredTypeOf(site: Node, name: string): Declared | undefined {
  // A local's scope starts at its declared name, so a site inside its own initializer, or a later declarator's, sees it.
  const fromDeclarator = (declaration: Node): Declared | undefined => {
    for (const declarator of childrenOf(declaration)) {
      const declared = declarator.childForFieldName("name");
      if (declarator.type !== "variable_declarator" || declared?.text !== name || declared.endIndex > site.startIndex) continue;
      const type = declaration.childForFieldName("type");
      if (type === null) return null;
      return { type, dimensions: (declarator.childForFieldName("dimensions")?.text ?? "").replace(/\s+/g, ""), varargs: false, initializer: declarator.childForFieldName("value") ?? undefined };
    }
    return undefined;
  };
  const fromParameter = (parameter: Node): Declared | undefined => {
    if (parameter.type === "formal_parameter" && parameter.childForFieldName("name")?.text === name) {
      const type = parameter.childForFieldName("type");
      return type === null ? null : { type, dimensions: (parameter.childForFieldName("dimensions")?.text ?? "").replace(/\s+/g, ""), varargs: false };
    }
    if (parameter.type === "spread_parameter" && childOfType(parameter, "variable_declarator")?.childForFieldName("name")?.text === name) {
      const type = childrenOf(parameter).find((part) => part.type !== "modifiers" && part.type !== "variable_declarator");
      return type === undefined ? null : { type, dimensions: "", varargs: true };
    }
    return undefined;
  };
  // A pattern variable's scope follows the flow of the condition; any one of this name in the method leaves the name unknown.
  const patterned = (body: Node): boolean => {
    const pending = [body];
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if ((node.type === "instanceof_expression" || node.type === "type_pattern" || node.type === "record_pattern_component") && node.childForFieldName("name")?.text === name) return true;
      if (node.type === "type_pattern" && childrenOf(node).some((part) => part.type === "identifier" && part.text === name)) return true;
      pending.push(...childrenOf(node));
    }
    return false;
  };
  for (let holder: Node = site, scope = site.parent; scope !== null; holder = scope, scope = scope.parent) {
    switch (scope.type) {
      case "block":
      case "constructor_body":
      case "switch_block_statement_group": {
        for (const child of childrenOf(scope)) {
          if (child.startIndex > holder.startIndex) break;
          if (child.type === "local_variable_declaration") { const found = fromDeclarator(child); if (found !== undefined) return found; }
        }
        break;
      }
      case "switch_block": {
        // A local declared in an earlier case group of the same switch is still in scope.
        for (const group of childrenOf(scope)) {
          if (group.startIndex >= holder.startIndex) break;
          for (const child of childrenOf(group)) if (child.type === "local_variable_declaration") { const found = fromDeclarator(child); if (found !== undefined) return found; }
        }
        break;
      }
      case "for_statement": {
        const init = scope.childForFieldName("init");
        if (init !== null && init.type === "local_variable_declaration") { const found = fromDeclarator(init); if (found !== undefined) return found; }
        break;
      }
      case "enhanced_for_statement": {
        if (scope.childForFieldName("name")?.text === name && holder.id === scope.childForFieldName("body")?.id) {
          const type = scope.childForFieldName("type");
          return type === null ? null : { type, dimensions: (scope.childForFieldName("dimensions")?.text ?? "").replace(/\s+/g, ""), varargs: false };
        }
        break;
      }
      case "try_with_resources_statement": {
        // A resource is in scope from its declared name: in its own initializer, the later resources and the try body, not
        // in a catch or finally clause.
        if (holder.id !== scope.childForFieldName("body")?.id && holder.type !== "resource_specification") break;
        for (const resource of childrenOf(childOfType(scope, "resource_specification") ?? scope)) {
          const declared = resource.childForFieldName("name");
          if (resource.type !== "resource" || declared?.text !== name || declared.endIndex > site.startIndex) continue;
          const type = resource.childForFieldName("type");
          return type === null ? null : { type, dimensions: "", varargs: false };
        }
        break;
      }
      case "catch_clause": {
        const parameter = childOfType(scope, "catch_formal_parameter");
        if (parameter !== null && parameter.childForFieldName("name")?.text === name) {
          const types = childrenOf(childOfType(parameter, "catch_type") ?? parameter);
          return types.length === 1 ? { type: types[0]!, dimensions: "", varargs: false } : null;
        }
        break;
      }
      case "lambda_expression": {
        const parameters = scope.childForFieldName("parameters");
        if (parameters === null) break;
        if (parameters.type === "identifier") { if (parameters.text === name) return null; break; }
        for (const parameter of childrenOf(parameters)) {
          if (parameter.type === "identifier" && parameter.text === name) return null;
          const found = fromParameter(parameter);
          if (found !== undefined) return found;
        }
        break;
      }
      case "method_declaration":
      case "constructor_declaration":
      case "compact_constructor_declaration": {
        for (const parameter of childrenOf(scope.childForFieldName("parameters") ?? scope)) {
          const found = fromParameter(parameter);
          if (found !== undefined) return found;
        }
        const body = scope.childForFieldName("body");
        if (body !== null && patterned(body)) return null;
        break;
      }
      case "class_body":
      case "interface_body":
      case "enum_body_declarations":
      case "enum_body": {
        for (const member of childrenOf(scope)) {
          if (member.type === "field_declaration" || member.type === "constant_declaration") { const found = fromDeclarator(member); if (found !== undefined) return found; }
          if (member.type === "enum_body_declarations") for (const inner of childrenOf(member)) if (inner.type === "field_declaration") { const found = fromDeclarator(inner); if (found !== undefined) return found; }
        }
        const owner = scope.type === "enum_body_declarations" ? scope.parent?.parent ?? null : scope.parent;
        if (owner === null) return undefined;
        if (owner.type === "record_declaration") for (const parameter of childrenOf(owner.childForFieldName("parameters") ?? owner)) { const found = fromParameter(parameter); if (found !== undefined) return found; }
        // An inherited field of this name would shadow anything further out: a type with a supertype, or an anonymous
        // class, leaves the name unknown.
        if (owner.type === "object_creation_expression") return null;
        if (owner.childForFieldName("superclass") !== null || childrenOf(owner).some((part) => part.type === "super_interfaces" || part.type === "extends_interfaces")) return null;
        if (owner.type === "enum_declaration") return null;
        if (scope.type === "enum_body_declarations") { holder = scope; scope = owner.parent ?? owner; continue; }
        break;
      }
      default:
        break;
    }
  }
  return undefined;
}

const DECLARATIONS = /^(?:class|interface|enum|record|annotation_type)_declaration$/;

// The type variables in scope at a node and their first bounds, innermost declaration first.
function boundsAt(node: Node): Map<string, string | undefined | null> {
  const bounds = new Map<string, string | undefined | null>();
  for (let scope: Node | null = node; scope !== null; scope = scope.parent) {
    if (!DECLARATIONS.test(scope.type) && scope.type !== "method_declaration" && scope.type !== "constructor_declaration") continue;
    for (const [name, bound] of typeBoundsOf(scope)) if (!bounds.has(name)) bounds.set(name, bound);
  }
  return bounds;
}

// The full name of the class `this` means at a node: its package and each enclosing member type. An anonymous or local
// class, or an enum constant's body, has no name a parameter type can write.
function thisTypeAt(node: Node, packageName: string): string | undefined {
  let body: Node | null = node.parent;
  while (body !== null && body.type !== "class_body" && body.type !== "interface_body" && body.type !== "enum_body" && body.type !== "enum_body_declarations") body = body.parent;
  let owner = body?.type === "enum_body_declarations" ? body.parent?.parent ?? null : body?.parent ?? null;
  const chain: string[] = [];
  while (owner !== null && DECLARATIONS.test(owner.type)) {
    const name = owner.childForFieldName("name")?.text;
    if (name === undefined) return undefined;
    chain.unshift(name);
    const container = owner.parent;
    if (container === null || container.type === "program") break;
    if (!MEMBER_PARENTS.has(container.type) && container.type !== "enum_body") return undefined;
    owner = container.type === "enum_body_declarations" ? container.parent?.parent ?? null : container.parent;
  }
  if (owner === null || !DECLARATIONS.test(owner.type) || chain.length === 0) return undefined;
  return packageName.length > 0 ? `${packageName}.${chain.join(".")}` : chain.join(".");
}

export const javaAdapter: LanguageAdapter = {
  language: "java",
  extract(tree, _source): AdapterOutput {
    const out = new Extractor();
    const bindings = collectTypedBindings(tree.rootNode, javaSpec);
    const scope = typeScopeOf(tree.rootNode);
    const typeVariables: string[][] = [];
    const inScope = (): ReadonlySet<string> => new Set(typeVariables.flat());
    // The erased type an expression is written to have, with the simple names it read from this file's scope.
    type Typed = { readonly type: string | null; readonly names: readonly string[] };
    const unknown: Typed = { type: null, names: [] };
    const erasedAt = (written: string, at: Node): Typed => {
      const names = new Set<string>();
      const type = erasedType(written, scope, boundsAt(at), names);
      return type === undefined ? unknown : { type, names: [...names] };
    };
    const typeOf = (node: Node, depth = 0): Typed => {
      if (depth > 6) return unknown;
      switch (node.type) {
        case "string_literal": case "text_block": return { type: "java.lang.String", names: [] };
        case "character_literal": return { type: "char", names: [] };
        case "true": case "false": return { type: "boolean", names: [] };
        case "null_literal": return { type: "null", names: [] };
        case "decimal_integer_literal": case "hex_integer_literal": case "octal_integer_literal": case "binary_integer_literal":
          return { type: /[lL]$/.test(node.text) ? "long" : "int", names: [] };
        case "decimal_floating_point_literal": case "hex_floating_point_literal": return { type: /[fF]$/.test(node.text) ? "float" : "double", names: [] };
        case "class_literal": return { type: "java.lang.Class", names: [] };
        case "parenthesized_expression": { const inner = childrenOf(node).find((child) => !COMMENTS.has(child.type)); return inner === undefined ? unknown : typeOf(inner, depth + 1); }
        case "cast_expression": {
          const value = node.childForFieldName("value");
          const types = childrenOf(node).filter((child) => child.id !== value?.id && !COMMENTS.has(child.type));
          const type = node.childForFieldName("type");
          return type === null || types.length !== 1 ? unknown : erasedAt(type.text, node);
        }
        case "object_creation_expression": {
          const type = node.childForFieldName("type");
          if (type === null || childOfType(node, "class_body") !== null) return unknown;
          if (childrenOf(node).some((child) => !COMMENTS.has(child.type) && child.endIndex <= type.startIndex && child.type !== "type_arguments" && !child.type.endsWith("annotation"))) return unknown;
          return erasedAt(type.text, node);
        }
        case "array_creation_expression": {
          const type = node.childForFieldName("type");
          if (type === null) return unknown;
          const dimensions = childrenOf(node).filter((child) => child.type === "dimensions_expr").length +
            childrenOf(node).filter((child) => child.type === "dimensions").reduce((total, child) => total + (child.text.match(/\[/g)?.length ?? 0), 0);
          return dimensions === 0 ? unknown : erasedAt(`${type.text}${"[]".repeat(dimensions)}`, node);
        }
        case "this": { const type = thisTypeAt(node, scope.packageName); return type === undefined ? unknown : { type, names: [] }; }
        case "identifier": {
          const declared = declaredTypeOf(node, node.text);
          if (declared === undefined || declared === null) return unknown;
          if (declared.type.type === "type_identifier" && declared.type.text === "var") {
            const value = declared.initializer;
            return value !== undefined && ["object_creation_expression", "string_literal", "cast_expression", "array_creation_expression"].includes(value.type) ? typeOf(value, depth + 1) : unknown;
          }
          return erasedAt(`${declared.type.text}${declared.dimensions}${declared.varargs ? "[]" : ""}`, declared.type);
        }
        case "field_access": {
          const object = node.childForFieldName("object");
          const field = node.childForFieldName("field");
          if (object?.type !== "this" || field === null) return unknown;
          // `this.x` names a field of the class `this` means, never a local.
          let body: Node | null = node.parent;
          while (body !== null && body.type !== "class_body" && body.type !== "enum_body_declarations" && body.type !== "interface_body") body = body.parent;
          if (body === null || thisTypeAt(node, scope.packageName) === undefined) return unknown;
          const probe = childrenOf(body).find((member) => member.type === "field_declaration" && childrenOf(member).some((declarator) => declarator.type === "variable_declarator" && declarator.childForFieldName("name")?.text === field.text));
          if (probe === undefined) return unknown;
          const declarator = childrenOf(probe).find((part) => part.type === "variable_declarator" && part.childForFieldName("name")?.text === field.text)!;
          const type = probe.childForFieldName("type");
          return type === null || type.text === "var" ? unknown : erasedAt(`${type.text}${(declarator.childForFieldName("dimensions")?.text ?? "").replace(/\s+/g, "")}`, type);
        }
        case "binary_expression": {
          const operator = node.childForFieldName("operator")?.type ?? node.children.find((child) => child !== null && !child.isNamed)?.type;
          if (["==", "!=", "<", ">", "<=", ">=", "&&", "||"].includes(operator ?? "")) return { type: "boolean", names: [] };
          const left = node.childForFieldName("left"), right = node.childForFieldName("right");
          if (left === null || right === null) return unknown;
          const a = typeOf(left, depth + 1), b = typeOf(right, depth + 1);
          const names = [...a.names, ...b.names];
          if (operator === "+" && (a.type === "java.lang.String" || b.type === "java.lang.String")) return { type: "java.lang.String", names };
          if (["+", "-", "*", "/", "%"].includes(operator ?? "") && a.type !== null && b.type !== null) { const type = promoted(a.type, b.type); return type === undefined ? unknown : { type, names }; }
          return unknown;
        }
        case "unary_expression": {
          const operator = node.childForFieldName("operator")?.type ?? node.children.find((child) => child !== null && !child.isNamed)?.type;
          if (operator === "!") return { type: "boolean", names: [] };
          const operand = node.childForFieldName("operand");
          if (operand === null) return unknown;
          const inner = typeOf(operand, depth + 1);
          const type = inner.type === null ? undefined : promoted(inner.type, "int");
          return type === undefined ? unknown : { type, names: inner.names };
        }
        case "instanceof_expression": return { type: "boolean", names: [] };
        case "ternary_expression": {
          const a = node.childForFieldName("consequence"), b = node.childForFieldName("alternative");
          if (a === null || b === null) return unknown;
          const left = typeOf(a, depth + 1), right = typeOf(b, depth + 1);
          return left.type !== null && left.type === right.type && left.type !== "null" ? { type: left.type, names: [...left.names, ...right.names] } : unknown;
        }
        default: return unknown;
      }
    };
    const argumentTypesOf = (list: Node | null): ArgumentTypes | undefined => {
      if (list === null) return undefined;
      const typed = childrenOf(list).filter((child) => !COMMENTS.has(child.type)).map((argument) => typeOf(argument));
      if (!typed.some((one) => one.type !== null)) return undefined;
      const names = [...new Set(typed.flatMap((one) => one.names))].sort();
      return { types: typed.map((one) => one.type), ...(names.length > 0 ? { names } : {}) };
    };

    const visit = (node: Node): void => {
      switch (node.type) {
        case "class_declaration":
        case "interface_declaration":
        case "enum_declaration":
        case "record_declaration": {
          const nameNode = node.childForFieldName("name");
          if (nameNode === null) return;
          const kind =
            node.type === "interface_declaration"
              ? "interface"
              : node.type === "enum_declaration"
                ? "enum"
                : "class";
          out.addDef(nameNode.text, kind, node, undefined, undefined, node.type === "class_declaration" ? bindings.heritage(node) : undefined, undefined, undefined, undefined, bindings.fieldTypes(childrenOf(node.childForFieldName("body") ?? node)), undefined, undefined, bindings.elementTypes(childrenOf(node.childForFieldName("body") ?? node)), undefined, bindings.valueTypes(childrenOf(node.childForFieldName("body") ?? node)));
          const supertypes = (node.childForFieldName("superclass") === null ? 0 : 1) + childrenOf(node)
            .filter((child) => child.type === "super_interfaces" || child.type === "extends_interfaces")
            .reduce((total, clause) => total + childrenOf(childOfType(clause, "type_list") ?? clause).length, 0);
          if (supertypes > 0) out.markSupertypes(supertypes, bindings.interfaces(node));
          // A record always has a canonical constructor, written on its header or in a compact declaration.
          if (node.type === "record_declaration") out.markPrimary();
          const access = MEMBER_PARENTS.has(node.parent?.type ?? "") ? accessOf(node) : undefined;
          if (access !== undefined) out.markAccess(access);
          out.push(nameNode.text);
          typeVariables.push(typeParametersOf(node));
          for (const child of childrenOf(node)) visit(child);
          typeVariables.pop();
          out.pop();
          return;
        }
        case "method_declaration":
        case "compact_constructor_declaration":
        case "constructor_declaration": {
          let nameNode = node.childForFieldName("name");
          if (nameNode === null && node.type === "compact_constructor_declaration") {
            nameNode = childrenOf(node).find((c) => c.type === "identifier") ?? null;
          }
          if (nameNode !== null) {
            out.addDef(nameNode.text, "method", node, undefined, bindings.memberKind(node), undefined, undefined, bindings.returns(node), undefined, undefined, undefined, bindings.elements(node), undefined, bindings.values(node));
            const parameters = node.childForFieldName("parameters");
            typeVariables.push(typeParametersOf(node));
            if (parameters !== null) out.setParameters(parameterRange(parameters, node, scope, inScope()));
            out.push(nameNode.text);
            for (const child of childrenOf(node)) visit(child);
            out.pop();
            typeVariables.pop();
          }
          return;
        }
        case "field_declaration": {
          const modifiers = childOfType(node, "modifiers");
          const hasFinal = modifiers !== null && /\bfinal\b/.test(modifiers.text);
          if (hasFinal) {
            for (const declarator of childrenOf(node)) {
              if (declarator.type !== "variable_declarator") continue;
              const nameNode = declarator.childForFieldName("name");
              if (nameNode !== null && /^[A-Z][A-Z0-9_]*$/.test(nameNode.text)) {
                out.addDef(nameNode.text, "constant", declarator);
              }
            }
          }
          for (const child of childrenOf(node)) visit(child);
          return;
        }
        case "method_invocation": {
          const nameNode = node.childForFieldName("name");
          if (nameNode !== null) out.addEdge("calls", nameNode.text, nameNode, bindings.at(node, node), undefined, argumentCount(node.childForFieldName("arguments")), undefined, argumentTypesOf(node.childForFieldName("arguments")));
          for (const child of childrenOf(node)) visit(child);
          return;
        }
        case "explicit_constructor_invocation": {
          out.addEdge("calls", node.text.trimStart().startsWith("super") ? "super" : "this", node.childForFieldName("constructor") ?? node);
          for (const child of childrenOf(node)) visit(child);
          return;
        }
        case "object_creation_expression": {
          // `new Box<>(1)` names Box; a class body after the arguments makes an anonymous subclass. `a.new Inner()`
          // names a member type of the qualifying instance's type, which the index does not follow, so it is a plain call.
          const typeNode = node.childForFieldName("type");
          if (typeNode !== null) {
            const qualified = childrenOf(node).some((child) => child.type !== "comment" && child.endIndex <= typeNode.startIndex && child.type !== "type_arguments" && !child.type.endsWith("annotation"));
            const anonymous = childOfType(node, "class_body") !== null;
            if (qualified) out.addEdge("calls", typeNode.text, typeNode);
            else out.addEdge("calls", withoutTypeArguments(typeNode.text), typeNode, undefined, undefined, argumentCount(node.childForFieldName("arguments")), anonymous ? "anonymous" : "instance", argumentTypesOf(node.childForFieldName("arguments")));
          }
          for (const child of childrenOf(node)) visit(child);
          return;
        }
        case "import_declaration": {
          const importPath = childrenOf(node).find((c) => c.type === "scoped_identifier");
          if (importPath !== undefined) out.addEdge("imports", importPath.text, node);
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
