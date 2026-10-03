import type { Node } from "web-tree-sitter";
import { childOfType, childrenOf } from "./util.js";

// The written type of a C# receiver expression, for choosing the extension method a member call binds. A type is
// written as C# writes it, whitespace and `@` removed: a predefined keyword (`int`), a dotted name with type arguments
// (`List<int>`, `global::N.T`), `?` for a nullable type and `[]` (`[,]`) per array rank; `this` names the enclosing
// type. Undefined when the expression's type is not written down, or names a type parameter in scope.

const plain = (identifier: string): string => identifier
  .replace(/\\u([0-9A-Fa-f]{4})|\\U([0-9A-Fa-f]{8})/g, (_, short: string | undefined, long: string | undefined) => String.fromCodePoint(parseInt(short ?? long!, 16)))
  .replace(/^@/, "")
  .replace(/\p{Cf}/gu, "");

const COMMENTS = new Set(["comment"]);
const named = (node: Node): Node[] => childrenOf(node).filter((child) => !COMMENTS.has(child.type));

// Whether an enclosing declaration (a type, method or local function) declares a type parameter of this name.
function typeParameterInScope(node: Node, name: string): boolean {
  for (let scope = node.parent; scope !== null; scope = scope.parent) {
    const list = childOfType(scope, "type_parameter_list");
    if (list !== null && childrenOf(list).some((parameter) => parameter.type === "type_parameter" && childrenOf(parameter).some((child) => child.type === "identifier" && plain(child.text) === name))) return true;
  }
  return false;
}

// A type node written out, or undefined for a form this does not read (a tuple, pointer or function pointer type) or a
// name that is a type parameter in scope at `site`.
export function writtenType(type: Node | null, site: Node): string | undefined {
  if (type === null) return undefined;
  switch (type.type) {
    case "predefined_type": return type.text.replace(/\s+/g, "");
    case "identifier": {
      const name = plain(type.text);
      return typeParameterInScope(site, name) ? undefined : name;
    }
    case "generic_name": {
      const name = named(type).find((child) => child.type === "identifier");
      const list = childOfType(type, "type_argument_list");
      if (name === undefined || list === null) return undefined;
      const args = named(list).map((argument) => writtenType(argument, site));
      return args.some((argument) => argument === undefined) ? undefined : `${plain(name.text)}<${args.join(",")}>`;
    }
    case "qualified_name": {
      const parts = named(type);
      const first = parts[0] === undefined ? undefined : parts[0].type === "identifier" ? plain(parts[0].text) : writtenType(parts[0], site);
      const rest = parts.slice(1).map((part) => part.type === "identifier" ? plain(part.text) : writtenType(part, site));
      // Only the first segment can be a type parameter; a later one is a member of what comes before.
      if (first === undefined || rest.some((part) => part === undefined)) return undefined;
      if (parts[0]!.type === "identifier" && typeParameterInScope(site, first)) return undefined;
      return [first, ...rest].join(".");
    }
    case "alias_qualified_name": {
      const parts = named(type);
      if (parts.length !== 2 || parts[0]!.type !== "identifier") return undefined;
      const tail = parts[1]!.type === "identifier" ? plain(parts[1]!.text) : writtenType(parts[1]!, site);
      return tail === undefined ? undefined : `${plain(parts[0]!.text)}::${tail}`;
    }
    case "nullable_type": {
      const inner = writtenType(named(type)[0] ?? null, site);
      return inner === undefined ? undefined : `${inner}?`;
    }
    case "array_type": {
      const element = writtenType(type.childForFieldName("type"), site);
      const rank = childOfType(type, "array_rank_specifier");
      if (element === undefined || rank === null) return undefined;
      const commas = childrenOf(rank).filter((child) => child.type === ",").length;
      return `${element}[${",".repeat(commas)}]`;
    }
    default: return undefined;
  }
}

// The type C# gives an integer literal: the first of int, uint, long and ulong (narrowed by a `u` or `l` suffix) that
// holds its value.
function integerType(text: string): string | undefined {
  const lower = text.replace(/_/g, "").toLowerCase();
  const suffix = /(?:ul|lu|u|l)$/.exec(lower)?.[0] ?? "";
  const digits = lower.slice(0, lower.length - suffix.length);
  let value: bigint;
  try { value = BigInt(digits); } catch { return undefined; }
  const candidates = suffix === "" ? ["int", "uint", "long", "ulong"] : suffix === "u" ? ["uint", "ulong"] : suffix === "l" ? ["long", "ulong"] : ["ulong"];
  const max: Record<string, bigint> = { int: 2n ** 31n - 1n, uint: 2n ** 32n - 1n, long: 2n ** 63n - 1n, ulong: 2n ** 64n - 1n };
  return candidates.find((candidate) => value <= max[candidate]!);
}

function realType(text: string): string {
  const last = text.slice(-1).toLowerCase();
  return last === "f" ? "float" : last === "m" ? "decimal" : "double";
}

// The declaration a simple name refers to at `site`, as the type node it is declared with (`implicit_type` for `var`)
// and its initializer, or null when the name is declared without a written type (an untyped lambda parameter, a
// pattern or `out` variable, `value` in an accessor) or may be a member a base type supplies; undefined when no
// declaration of the name is found, so the name may be a type or a member a `using static` imports.
type Declared = { readonly type: Node; readonly initializer?: Node | undefined } | null;

function declaredIn(declaration: Node, name: string, site: Node, local: boolean): Declared | undefined {
  const type = declaration.childForFieldName("type") ?? named(declaration)[0] ?? null;
  for (const declarator of named(declaration)) {
    if (declarator.type !== "variable_declarator") continue;
    const declared = declarator.childForFieldName("name") ?? named(declarator).find((child) => child.type === "identifier");
    if (declared === undefined || plain(declared.text) !== name) continue;
    // A local is in scope from its declared name on; a field anywhere in its type's body.
    if (local && declared.endIndex > site.startIndex) continue;
    if (type === null) return null;
    const value = childOfType(declarator, "equals_value_clause");
    return { type, initializer: value === null ? undefined : named(value)[0] };
  }
  return undefined;
}

// A parameter list's parameter of this name: `params T[] rest` is written as a bare `params` token, the array type and
// the name in the list itself.
function parameterIn(list: Node, name: string): Declared | undefined {
  const children = named(list);
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i]!;
    if (child.type === "parameter") {
      const declared = child.childForFieldName("name") ?? named(child).filter((part) => part.type === "identifier").at(-1);
      if (declared === undefined || plain(declared.text) !== name) continue;
      const type = child.childForFieldName("type");
      return type === null ? null : { type };
    }
    if (child.type === "identifier" && plain(child.text) === name && i > 0 && children[i - 1]!.type === "array_type") return { type: children[i - 1]! };
  }
  return undefined;
}

// Whether a pattern or `out` variable of this name is declared anywhere under `node`, outside nested lambdas and local
// functions; its scope is not the block it is written in, so its type is not taken.
function expressionVariable(node: Node, name: string): boolean {
  const pending = [node];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (current.type === "declaration_pattern" || current.type === "declaration_expression" || current.type === "var_pattern" || current.type === "recursive_pattern") {
      if (named(current).some((child) => (child.type === "identifier" || child.type === "single_variable_designation") && plain(child.text) === name)) return true;
    }
    pending.push(...named(current));
  }
  return false;
}

const TYPE_DECLARATIONS = new Set(["class_declaration", "struct_declaration", "record_declaration", "record_struct_declaration", "interface_declaration"]);
const FUNCTIONS = new Set(["method_declaration", "constructor_declaration", "destructor_declaration", "operator_declaration", "conversion_operator_declaration", "local_function_statement", "lambda_expression", "anonymous_method_expression"]);

function declaredTypeOf(site: Node, name: string, membersOnly = false): Declared | undefined {
  for (let holder: Node = site, scope = site.parent; scope !== null; holder = scope, scope = scope.parent) {
    if (membersOnly && !TYPE_DECLARATIONS.has(scope.type)) continue;
    switch (scope.type) {
      case "block":
      case "switch_section": {
        for (const child of named(scope)) {
          if (child.startIndex > holder.startIndex) break;
          if (child.type === "local_declaration_statement") {
            const declaration = childOfType(child, "variable_declaration");
            const found = declaration === null ? undefined : declaredIn(declaration, name, site, true);
            if (found !== undefined) return found;
          }
        }
        if (expressionVariable(scope, name)) return null;
        break;
      }
      case "for_statement":
      case "using_statement":
      case "fixed_statement": {
        const declaration = childOfType(scope, "variable_declaration");
        const found = declaration === null ? undefined : declaredIn(declaration, name, site, true);
        if (found !== undefined) return found;
        if (expressionVariable(scope, name)) return null;
        break;
      }
      case "for_each_statement": {
        const left = scope.childForFieldName("left");
        if (left !== null && left.type === "identifier" && plain(left.text) === name && holder.id === scope.childForFieldName("body")?.id) {
          const type = scope.childForFieldName("type");
          return type === null || type.type === "implicit_type" ? null : { type };
        }
        if (left !== null && left.type !== "identifier" && holder.id === scope.childForFieldName("body")?.id && left.text.includes(name)) return null;
        break;
      }
      case "catch_clause": {
        const declaration = childOfType(scope, "catch_declaration");
        const declared = declaration === null ? undefined : named(declaration).find((child) => child.type === "identifier" && child.id !== declaration.childForFieldName("type")?.id);
        if (declaration !== null && declared !== undefined && plain(declared.text) === name) {
          const type = declaration.childForFieldName("type") ?? named(declaration)[0] ?? null;
          return type === null ? null : { type };
        }
        break;
      }
      case "accessor_declaration": {
        if (name === "value") return null;
        break;
      }
      default: break;
    }
    if (FUNCTIONS.has(scope.type)) {
      const list = scope.childForFieldName("parameters") ?? childOfType(scope, "parameter_list");
      if (list !== null) {
        const found = parameterIn(list, name);
        if (found !== undefined) return found;
      } else if (scope.type === "lambda_expression") {
        // `x => ...` writes its one parameter as a bare identifier.
        const first = named(scope)[0];
        if (first !== undefined && first.type === "identifier" && plain(first.text) === name) return null;
      }
      if (scope.type === "indexer_declaration") return null;
    }
    if (TYPE_DECLARATIONS.has(scope.type)) {
      const record = childOfType(scope, "parameter_list");
      if (record !== null) {
        const found = parameterIn(record, name);
        if (found !== undefined) return found;
      }
      const body = scope.childForFieldName("body") ?? childOfType(scope, "declaration_list");
      for (const member of body === null ? [] : named(body)) {
        if (member.type === "field_declaration" || member.type === "event_field_declaration") {
          const declaration = childOfType(member, "variable_declaration");
          const found = declaration === null ? undefined : declaredIn(declaration, name, site, false);
          if (found !== undefined) return found;
        }
        if (member.type === "property_declaration" || member.type === "event_declaration") {
          const declared = member.childForFieldName("name");
          if (declared !== null && plain(declared.text) === name) {
            const type = member.childForFieldName("type");
            return type === null ? null : { type };
          }
        }
        // Any other member of the name (a method, a nested type) is not a value whose type is written.
        if ((member.type === "method_declaration" || TYPE_DECLARATIONS.has(member.type) || member.type === "enum_declaration" || member.type === "delegate_declaration")
          && plain(member.childForFieldName("name")?.text ?? "") === name) return null;
      }
      // A base type may declare a member of the name, and a primary constructor's parameters (which this grammar reads
      // as an error) are not in the tree.
      if (childOfType(scope, "base_list") !== null || childOfType(scope, "ERROR") !== null) return null;
      // `this.name` reads the innermost type only.
      if (membersOnly) return undefined;
    }
  }
  return undefined;
}

// The written type of a value a declaration's `var` initializer has: a creation, cast, `as`, `default(T)` or literal.
function initializerType(value: Node | undefined, site: Node, depth: number): string | undefined {
  return value === undefined ? undefined : receiverTypeOf(value, site, depth + 1);
}

export function receiverTypeOf(expression: Node, site: Node = expression, depth = 0): string | undefined {
  if (depth > 4) return undefined;
  switch (expression.type) {
    case "integer_literal": return integerType(expression.text);
    case "real_literal": return realType(expression.text);
    case "string_literal":
    case "verbatim_string_literal":
    case "interpolated_string_expression": return "string";
    case "character_literal": return "char";
    case "boolean_literal": return "bool";
    case "object_creation_expression": return writtenType(expression.childForFieldName("type"), site);
    case "array_creation_expression": return writtenType(expression.childForFieldName("type"), site);
    case "cast_expression": return writtenType(expression.childForFieldName("type"), site);
    case "as_expression": return writtenType(expression.childForFieldName("right"), site);
    case "default_expression": return writtenType(expression.childForFieldName("type"), site);
    case "type_of_expression": return "System.Type";
    case "this_expression": return "this";
    case "parenthesized_expression": {
      const inner = named(expression)[0];
      return inner === undefined ? undefined : receiverTypeOf(inner, site, depth + 1);
    }
    case "identifier": {
      const declared = declaredTypeOf(site, plain(expression.text));
      if (declared === undefined || declared === null) return undefined;
      if (declared.type.type === "implicit_type") return initializerType(declared.initializer, site, depth);
      return writtenType(declared.type, site);
    }
    case "member_access_expression": {
      // `this.name` reads a field or property of the enclosing type.
      const object = expression.childForFieldName("expression");
      const member = expression.childForFieldName("name");
      if (object?.type !== "this_expression" || member === null || member.type !== "identifier") return undefined;
      const declared = declaredTypeOf(object, plain(member.text), true);
      if (declared === undefined || declared === null || declared.type.type === "implicit_type") return undefined;
      return writtenType(declared.type, site);
    }
    default: return undefined;
  }
}

// The source with comments and string and character literals blanked to spaces, offsets kept.
function blanked(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number) => { for (let k = from; k < to && k < out.length; k += 1) if (out[k] !== "\n") out[k] = " "; };
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (c === "/" && source[i + 1] === "/") { const end = source.indexOf("\n", i); const stop = end < 0 ? source.length : end; blank(i, stop); i = stop; continue; }
    if (c === "/" && source[i + 1] === "*") { const end = source.indexOf("*/", i + 2); const stop = end < 0 ? source.length : end + 2; blank(i, stop); i = stop; continue; }
    if (c === "'" ) { let k = i + 1; while (k < source.length && source[k] !== "'" && source[k] !== "\n") k += source[k] === "\\" ? 2 : 1; blank(i, k + 1); i = k + 1; continue; }
    if (c === "\"") {
      const quotes = /^"+/.exec(source.slice(i))![0].length;
      if (quotes >= 3) { const end = source.indexOf("\"".repeat(quotes), i + quotes); const stop = end < 0 ? source.length : end + quotes; blank(i, stop); i = stop; continue; }
      const verbatim = /[@][$]*$|[$]+@$/.test(source.slice(Math.max(0, i - 3), i));
      let k = i + 1;
      while (k < source.length) {
        if (verbatim && source[k] === "\"" && source[k + 1] === "\"") { k += 2; continue; }
        if (!verbatim && source[k] === "\\") { k += 2; continue; }
        if (source[k] === "\"" || (!verbatim && source[k] === "\n")) break;
        k += 1;
      }
      blank(i, k + 1); i = k + 1; continue;
    }
    i += 1;
  }
  return out.join("");
}

// Whether every parse error in the tree is a placeholder identifier the parser inserted (a zero-width leaf), which
// leaves the declarations around it where they are; an ERROR node can move or swallow them.
function placeholderErrorsOnly(root: Node): boolean {
  if (!root.hasError) return true;
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const failing: Node[] = [];
    for (let i = 0; i < node.childCount; i += 1) { const child = node.child(i); if (child !== null && child.hasError) failing.push(child); }
    if (failing.length === 0) {
      if (node.type !== "identifier" || node.startIndex !== node.endIndex) return false;
      continue;
    }
    pending.push(...failing);
  }
  return true;
}

const IDENTIFIER_CALL = /(?<![\p{L}\p{N}_.])([\p{L}_][\p{L}\p{N}_]*)\s*(?:<[^<>{};()]*>)?\s*\(/gu;

// Names of extension methods the file may declare that its tree does not place: every name declared as
// `Name(this ...` when the tree holds an error that can move a declaration, and every name written before `(` inside a
// C# 14 `extension(...) { ... }` block, which this grammar does not read.
export function unplacedExtensionNames(root: Node, source: string): string[] {
  const text = blanked(source);
  const names = new Set<string>();
  if (!placeholderErrorsOnly(root)) {
    for (const match of text.matchAll(/(?<![\p{L}\p{N}_.])([\p{L}_][\p{L}\p{N}_]*)\s*(?:<[^<>{};()]*>)?\s*\(\s*this\b/gu)) names.add(match[1]!);
  }
  for (const match of text.matchAll(/(?<![\p{L}\p{N}_.])extension\s*(?:<[^<>{};()]*>)?\s*\(/gu)) {
    const open = text.indexOf("{", match.index + match[0].length);
    if (open < 0) continue;
    let depth = 0;
    let close = text.length;
    for (let k = open; k < text.length; k += 1) {
      if (text[k] === "{") depth += 1;
      else if (text[k] === "}" && --depth === 0) { close = k; break; }
    }
    for (const call of text.slice(open, close).matchAll(IDENTIFIER_CALL)) names.add(call[1]!);
  }
  return [...names].sort();
}
