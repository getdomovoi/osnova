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

const KEYWORD_TYPES = new Set(["bool", "byte", "sbyte", "char", "short", "ushort", "int", "uint", "long", "ulong", "float", "double", "decimal", "string", "object", "dynamic", "var", "nint", "nuint", "void"]);

// A type node written out, or undefined for a form this does not read (a tuple, pointer or function pointer type) or a
// name that is a type parameter in scope at `site`.
export function writtenType(type: Node | null, site: Node): string | undefined {
  if (type === null) return undefined;
  switch (type.type) {
    case "predefined_type": return type.text.replace(/\s+/g, "");
    case "identifier": {
      const name = plain(type.text);
      // A keyword arrives as a `predefined_type`; an identifier that normalizes to one (`@int`, `i\u200Cnt`, `\u0069nt`)
      // names a type, which this does not read.
      if (KEYWORD_TYPES.has(name)) return undefined;
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
      // The commas are anonymous tokens, which the named-children list leaves out.
      const commas = rank.children.filter((child) => child?.type === ",").length;
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
type Declared = { readonly type: Node; readonly initializer?: Node | undefined; readonly constant?: boolean | undefined } | null;

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
    // A `const` local or field is a constant expression wherever it is named.
    const constant = (declaration.parent?.children ?? []).some((part) => part !== null && (part.type === "const" || (part.type === "modifier" && part.text === "const")));
    return { type, initializer: value === null ? undefined : named(value)[0], constant };
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

// The written type of each argument of a call, for choosing among extension methods, in the order and number
// `argumentCount` counts them: a written type as `receiverTypeOf` reads it, `#null` for the null literal,
// `#lit:<type>:<value>` for an integer literal (with its sign), `=A.B` for a dotted name whose first segment is no
// variable in scope (an enum member or a static member, which the index resolves), `#named` for a named argument and
// `#ref` for one passed `ref`, `out` or `in`; null where the type is not written down.
export function argumentTypesOf(list: Node, site: Node): (string | null)[] {
  return childrenOf(list).filter((child) => child.isNamed && !COMMENTS.has(child.type)).map((argument) => {
    if (argument.type !== "argument") return null;
    if (childOfType(argument, "name_colon") !== null) return "#named";
    if (argument.children.some((child) => child !== null && !child.isNamed && (child.type === "ref" || child.type === "out" || child.type === "in"))) return "#ref";
    const expression = named(argument).at(-1);
    return expression === undefined ? null : argumentTypeOf(expression, site);
  });
}

// Only a keyword names a literal type at extraction; `System.Int32` and the like are resolved names, which a nearer
// namespace, an alias or an indexed type can make something else, so a cast or default written with one stays unknown.
const LITERAL_SPELLINGS: Readonly<Record<string, string>> = { int: "int", uint: "uint", long: "long", ulong: "ulong" };
const INTEGRAL_SPELLINGS = new Set(["sbyte", "byte", "short", "ushort", "char", "nint", "nuint"]);
const INTEGRAL_NAMES = new Set(["Int32", "UInt32", "Int64", "UInt64", "SByte", "Byte", "Int16", "UInt16", "Char", "IntPtr", "UIntPtr"]);
const maybeIntegral = (written: string): boolean => INTEGRAL_SPELLINGS.has(written) || INTEGRAL_NAMES.has(written.slice(written.lastIndexOf(".") + 1).replace(/^.*::/u, ""));
const LITERAL_RANGE: Readonly<Record<string, readonly [bigint, bigint]>> = { int: [-2147483648n, 2147483647n], uint: [0n, 4294967295n], long: [-9223372036854775808n, 9223372036854775807n], ulong: [0n, 18446744073709551615n] };

function argumentTypeOf(expression: Node, site: Node, depth = 0): string | null {
  if (depth > 32) return null;
  // A parenthesized constant is the same constant.
  while (expression.type === "parenthesized_expression" && named(expression).length === 1) expression = named(expression)[0]!;
  if (expression.type === "null_literal") return "#null";
  const negative = expression.type === "prefix_unary_expression" && expression.children[0]?.type === "-" && named(expression).length === 1;
  let literal = negative ? named(expression)[0]! : expression;
  // The signed-minimum rule applies to the literal as the direct operand of the minus only.
  const direct = literal.type === "integer_literal";
  while (literal.type === "parenthesized_expression" && named(literal).length === 1) literal = named(literal)[0]!;
  if (literal.type === "integer_literal") {
    const type = integerType(literal.text);
    const digits = literal.text.replace(/_/g, "").toLowerCase().replace(/(?:ul|lu|u|l)$/, "");
    const suffixed = /(?:ul|lu|u|l)$/.test(literal.text.toLowerCase().replace(/_/g, ""));
    let value: bigint;
    try { value = BigInt(digits); } catch { return null; }
    if (type === undefined) return null;
    if (!negative) return `#lit:${type}:${value}`;
    // Unary minus: int and long stay; a uint operand promotes to long; the literals 2147483648 and 9223372036854775808
    // negated are int.MinValue and long.MinValue; a ulong operand has no unary minus.
    const negated = type === "int" || type === "long" ? type : type === "uint" ? (direct && !suffixed && value === 2147483648n ? "int" : "long") : direct && !suffixed && value === 9223372036854775808n ? "long" : null;
    return negated === null ? null : `#lit:${negated}:${-value}`;
  }
  if (negative) return null;
  // A cast of an integer literal to one of the literal types is that constant; to another type it is a constant whose
  // conversions this does not read. `default(T)` of a literal type is its zero.
  if (expression.type === "cast_expression") {
    const written = writtenType(expression.childForFieldName("type"), site);
    const target = written === undefined ? undefined : LITERAL_SPELLINGS[written];
    const operand = expression.childForFieldName("value") ?? named(expression).at(-1);
    const inner = operand === undefined || operand === null ? null : argumentTypeOf(operand, site, depth + 1);
    if (inner !== null && inner.startsWith("#lit:")) {
      // The value stays only when the target holds it; an overflowing cast is an error or, unchecked, another value.
      const value = BigInt(inner.slice(inner.lastIndexOf(":") + 1));
      const range = target === undefined ? undefined : LITERAL_RANGE[target];
      return range !== undefined && value >= range[0] && value <= range[1] ? `#lit:${target}:${value}` : null;
    }
    if (written === undefined || target !== undefined || maybeIntegral(written)) return null;
  }
  if (expression.type === "default_expression") {
    const written = writtenType(expression.childForFieldName("type"), site);
    if (written !== undefined && LITERAL_SPELLINGS[written] !== undefined) return `#lit:${LITERAL_SPELLINGS[written]}:0`;
    if (written === undefined || maybeIntegral(written)) return null;
  }
  if (expression.type === "identifier") {
    const declared = declaredTypeOf(site, plain(expression.text));
    if (declared !== undefined && declared !== null && declared.constant === true) return null;
  }
  if (expression.type === "member_access_expression") {
    const parts: string[] = [];
    let current: Node | null = expression;
    while (current?.type === "member_access_expression") {
      const name = current.childForFieldName("name");
      if (name === null || name.type !== "identifier") return null;
      parts.unshift(plain(name.text));
      current = current.childForFieldName("expression");
    }
    if (current === null || current.type !== "identifier") return null;
    const first = plain(current.text);
    // A variable in scope makes the name a member access on a value, whose type the member's declaration gives; a type
    // parameter's static member is not an enum member.
    if (declaredTypeOf(current, first) !== undefined || typeParameterInScope(current, first)) return null;
    return `=${[first, ...parts].join(".")}`;
  }
  return receiverTypeOf(expression, site) ?? null;
}

// C# ends a line at CR, LF, NEL, U+2028 and U+2029: a line comment and a regular literal end there.
const LINE_END = /[\r\n\u0085\u2028\u2029]/u;
const lineEnd = (source: string, from: number): number => {
  const rest = LINE_END.exec(source.slice(from));
  return rest === null ? source.length : from + rest.index;
};

// The source with comments and string and character literals blanked to spaces, offsets kept: a string's `$` and `@`
// prefix and `u8` suffix with it, and an interpolated string with its holes, as the tree's literal nodes hold them. A
// hole is lexed as code, so a literal or comment inside it does not end the string.
function blanked(source: string): { text: string; raw: [number, number][]; unterminated: boolean } {
  const out = source.split("");
  const raw: [number, number][] = [];
  let unterminated = false;
  const blank = (from: number, to: number) => { for (let k = from; k < to && k < out.length; k += 1) if (!LINE_END.test(out[k]!)) out[k] = " "; };
  // Code from `i`; inside an interpolation hole (`closers` > 0: the braces that close it), up to the run of `}` that
  // closes it, whose index it returns. A `:` outside any bracket (not `::`) starts the hole's format text, which is
  // not code and runs to that run.
  const code = (start: number, closers: number, nesting = 0): number => {
    // Past this nesting of literals in holes, the file is read unblanked rather than recursed into.
    if (nesting > 256) { unterminated = true; return source.length; }
    let depth = 0;
    let brackets = 0;
    let i = start;
    const closing = (at: number): boolean => source.startsWith("}".repeat(closers), at);
    while (i < source.length) {
      const c = source[i]!;
      if (closers > 0) {
        if (c === "{") { depth += 1; i += 1; continue; }
        if (c === "}") { if (depth === 0 && closing(i)) return i; if (depth > 0) depth -= 1; i += 1; continue; }
        if (c === "(" || c === "[") brackets += 1;
        else if ((c === ")" || c === "]") && brackets > 0) brackets -= 1;
        else if (c === ":" && depth === 0 && brackets === 0 && source[i + 1] !== ":" && source[i - 1] !== ":") {
          let k = i + 1;
          while (k < source.length && !closing(k)) k += 1;
          return k;
        }
      }
      if (c === "/" && source[i + 1] === "/") { const stop = lineEnd(source, i); blank(i, stop); i = stop; continue; }
      if (c === "/" && source[i + 1] === "*") { const end = source.indexOf("*/", i + 2); if (end < 0) unterminated = true; const stop = end < 0 ? source.length : end + 2; blank(i, stop); i = stop; continue; }
      if (c === "'") { let k = i + 1; while (k < source.length && source[k] !== "'" && !LINE_END.test(source[k]!)) k += source[k] === "\\" ? 2 : 1; if (source[k] !== "'") unterminated = true; blank(i, k + 1); i = k + 1; continue; }
      if (c === "\"") { i = literal(i, nesting); continue; }
      i += 1;
    }
    if (closers > 0) unterminated = true;
    return i;
  };
  // The string whose first quote is at `i`, blanked whole; the index just past it.
  const literal = (i: number, nesting: number): number => {
    let begin = i;
    while (begin > 0 && (source[begin - 1] === "$" || source[begin - 1] === "@")) begin -= 1;
    const prefix = source.slice(begin, i);
    const dollars = prefix.split("$").length - 1;
    const verbatim = prefix.includes("@");
    const quotes = /^"+/.exec(source.slice(i))![0].length;
    let k: number;
    if (quotes >= 3 && !verbatim) {
      // A raw string: its holes open with as many braces as it has `$`, and it closes at its own run of quotes.
      const close = "\"".repeat(quotes);
      k = i + quotes;
      while (k < source.length && !source.startsWith(close, k)) {
        if (dollars > 0 && source[k] === "{") {
          const run = /^\{+/.exec(source.slice(k))![0].length;
          k += run;
          if (run < dollars) continue;
          k = code(k, dollars, nesting + 1);
          k += /^\}*/.exec(source.slice(k))![0].length;
          continue;
        }
        k += 1;
      }
      if (k >= source.length) unterminated = true;
      k = Math.min(source.length, k + quotes);
      raw.push([begin, k]);
    } else {
      k = i + 1;
      while (k < source.length) {
        const c = source[k]!;
        if (verbatim && c === "\"" && source[k + 1] === "\"") { k += 2; continue; }
        if (!verbatim && c === "\\") { k += 2; continue; }
        if (dollars > 0 && c === "{") {
          if (source[k + 1] === "{") { k += 2; continue; }
          k = code(k + 1, 1, nesting + 1) + 1;
          continue;
        }
        if (c === "\"") { k += 1; break; }
        if (!verbatim && LINE_END.test(c)) { unterminated = true; break; }
        k += 1;
      }
      if (k >= source.length && source[k - 1] !== "\"") unterminated = true;
    }
    if (/^[uU]8/u.test(source.slice(k, k + 2))) k += 2;
    blank(begin, k);
    return k;
  };
  code(0, 0);
  return { text: out.join(""), raw, unterminated };
}

// Whether the blanked text blanks exactly what the tree reads as comments and literals (an interpolated string with its
// holes): two readings of the file's lexical structure, which must agree before either is trusted to hide no code.
const LITERALS = new Set(["comment", "string_literal", "verbatim_string_literal", "raw_string_literal", "character_literal", "interpolated_string_expression"]);
// Spans where the tree is no second reading are not compared: raw string literals, which this grammar does not read,
// and the nodes around ERROR nodes.
function blankingAgrees(literal: Uint8Array, source: string, text: string, skipped: readonly (readonly [number, number])[]): boolean {
  for (const [from, to] of skipped) literal.fill(2, from, to);
  for (let i = 0; i < source.length; i += 1) {
    if (literal[i] === 2 || /\s/u.test(source[i]!)) continue;
    if ((text[i] === " ") !== (literal[i] === 1)) return false;
  }
  return true;
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

// A C# identifier as written holds letters, digits, connectors, marks, formatting characters and \\u or \\U escapes,
// which `plain` decodes to the name the compiler sees.
const ESCAPE = String.raw`\\u[0-9A-Fa-f]{4}|\\U[0-9A-Fa-f]{8}`;

// Every identifier written in a range of the text.
function identifiersIn(text: string, from: number, to: number): string[] {
  return [...text.slice(from, to).matchAll(new RegExp(String.raw`@?(?:[\p{L}\p{Nl}_]|${ESCAPE})(?:[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}\p{Cf}]|${ESCAPE})*`, "gu"))].map((match) => match[0]);
}

// The index just past the bracket that closes the one at `open` (`(` or `{`), counting every bracket kind, or the
// end of the text when it does not close.
function pastClose(text: string, open: number): number {
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    const c = text[at]!;
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if ((c === ")" || c === "]" || c === "}") && --depth === 0) return at + 1;
  }
  return text.length;
}

// Names of extension members the file may declare that its tree does not place. Where the tree cannot be read as
// declarations, every identifier written there stands for a name it may declare, so none is missed: the node around an
// ERROR node, a
// C# 14 `extension(...) { ... }` block (which this grammar reads as a constructor named `extension`, as local
// functions or as an error), and the whole file when its tree holds an error that is neither an ERROR node nor a
// placeholder identifier the parser inserted, or when the blanked text and the tree disagree on what is a comment or a
// literal, or when the source holds a lone CR, NEL, U+2028 or U+2029, which this
// grammar does not read as ending a line comment, so a declaration after one can vanish into the comment without an
// error. Extra names only keep calls of those names unresolved.
export function unplacedExtensionNames(root: Node, source: string): string[] {
  const { text, raw, unterminated } = blanked(source);
  const skipped: [number, number][] = [...raw];
  const names = new Set<string>();
  const addRange = (from: number, to: number) => { for (const written of identifiersIn(text, from, to)) names.add(plain(written)); };
  const addRaw = (from: number, to: number) => { for (const written of identifiersIn(source, from, to)) names.add(plain(written)); };
  if (root.hasError) {
    let errorNodes = 0;
    const pending = [root];
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      // The node around an error, so a name the error splits (`Pr\u006Fbe`, whose escape this grammar cannot read) is read whole.
      if (node.type === "ERROR") { errorNodes += 1; const parent = node.parent ?? node; skipped.push([parent.startIndex, parent.endIndex]); addRaw(parent.startIndex, parent.endIndex); continue; }
      for (let i = 0; i < node.childCount; i += 1) { const child = node.child(i); if (child !== null && child.hasError) pending.push(child); }
    }
    if (errorNodes === 0 && !placeholderErrorsOnly(root)) addRange(0, text.length);
  }
  if (/\r(?!\n)|[\u0085\u2028\u2029]/u.test(source)) addRange(0, text.length);
  // One walk: the tree's comments and literals, and each block the grammar read as a constructor named `extension`.
  const literal = new Uint8Array(source.length);
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const type = node.type;
    if (LITERALS.has(type)) { literal.fill(1, node.startIndex, node.endIndex); continue; }
    if (type === "constructor_declaration" && plain(node.childForFieldName("name")?.text ?? "") === "extension") { addRange(node.startIndex, node.endIndex); continue; }
    pending.push(...childrenOf(node));
  }
  // Where the two readings of comments and literals differ, or a literal or comment never ends, either may hide code,
  // so every identifier written counts.
  if (unterminated || !blankingAgrees(literal, source, text, skipped)) addRaw(0, source.length);
  // A block header: the token `extension`, however it is spelled (`@extension` is an identifier, `x.extension` a member),
  // through the end of the body after its parameter list, attributes and initializers included.
  for (const match of text.matchAll(new RegExp(String.raw`(?<![\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}\p{Cf}_.@\\])(?:[\p{L}\p{Nl}_]|${ESCAPE})(?:[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}\p{Cf}]|${ESCAPE})*`, "gu"))) {
    if (plain(match[0]) !== "extension") continue;
    const parameters = text.indexOf("(", match.index);
    const afterParameters = parameters < 0 ? text.length : pastClose(text, parameters);
    const body = text.indexOf("{", afterParameters);
    addRange(match.index, body < 0 ? text.length : pastClose(text, body));
  }
  return [...names].sort();
}
