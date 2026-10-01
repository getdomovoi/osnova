import type { Node } from "web-tree-sitter";
import { Extractor, argumentCount, childOfType, childrenOf } from "./util.js";
import type { AdapterOutput, LanguageAdapter } from "./adapter.js";
import type { ParameterRange } from "../types.js";
import { collectTypedBindings, javaSpec } from "./typed-bindings.js";

// `@Override` is optional in Java, so a declaration without it counts as a further overload.
const annotatedOverride = (method: Node): boolean => childrenOf(childOfType(method, "modifiers") ?? method).some((child) =>
  child.type === "marker_annotation" && /^(?:java\.lang\.)?Override$/.test(child.childForFieldName("name")?.text ?? ""));

// A method a derived type cannot call (`private`), or only from the same package (no access modifier, outside an interface).
function accessOf(method: Node): ParameterRange["access"] {
  const words = new Set((childOfType(method, "modifiers")?.text ?? "").split(/\W+/));
  if (words.has("private")) return "private";
  if (words.has("public") || words.has("protected")) return undefined;
  return method.parent?.type === "interface_body" || method.parent?.type === "annotation_type_body" ? undefined : "package";
}

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

// A parameter type with every name replaced by the name it would mean from this file alone: primitives as
// written, a single-type import or java.lang by its full name, a package-qualified name as written, and any
// other simple name by this file's package. A type variable, a nested type of this file, or a name a wildcard
// or static import could supply proves nothing, and then the whole list is left unrecorded. `names` lists the
// simple names read from this file's scope; another file can still shadow them (an inherited nested type, or
// a same-package type over java.lang), so the resolver checks them before it compares types.
function canonicalType(written: string, scope: TypeScope, typeVariables: ReadonlySet<string>, names: Set<string>): string | undefined {
  const text = written.replace(/@[\w.$]+(?:\s*\([^)]*\))?/g, " ").replace(/\s*\.\s*/g, ".");
  let proven = true;
  const canonical = text.replace(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g, (name) => {
    if (PRIMITIVES.has(name) || name === "extends" || name === "super") return name;
    const [first = "", ...rest] = name.split(".");
    const tail = rest.length > 0 ? `.${rest.join(".")}` : "";
    if (typeVariables.has(first) || scope.unproven.has(first)) { proven = false; return name; }
    const imported = scope.imports.get(first);
    if (imported !== undefined) { names.add(first); return `${imported}${tail}`; }
    if (rest.length > 0 && /^[a-z]/.test(first)) return name;
    if (JAVA_LANG.has(first)) { names.add(first); return `java.lang.${name}`; }
    if (scope.open) { proven = false; return name; }
    names.add(first);
    return scope.packageName.length > 0 ? `${scope.packageName}.${name}` : name;
  }).replace(/\s+/g, "");
  return proven ? canonical : undefined;
}

function parameterRange(list: Node, method: Node, scope: TypeScope, typeVariables: ReadonlySet<string>): ParameterRange {
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
  return { min: count, ...(varargs ? {} : { max: count }), ...(overrides ? { overrides: true as const } : {}), ...(access === undefined ? {} : { access }),
    ...(proven ? { types, ...(names.size > 0 ? { names: [...names].sort() } : {}) } : {}) };
}

export const javaAdapter: LanguageAdapter = {
  language: "java",
  extract(tree, _source): AdapterOutput {
    const out = new Extractor();
    const bindings = collectTypedBindings(tree.rootNode, javaSpec);
    const scope = typeScopeOf(tree.rootNode);
    const typeVariables: string[][] = [];
    const inScope = (): ReadonlySet<string> => new Set(typeVariables.flat());

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
          if (nameNode !== null) out.addEdge("calls", nameNode.text, nameNode, bindings.at(node, node), undefined, argumentCount(node.childForFieldName("arguments")));
          for (const child of childrenOf(node)) visit(child);
          return;
        }
        case "explicit_constructor_invocation": {
          out.addEdge("calls", node.text.trimStart().startsWith("super") ? "super" : "this", node.childForFieldName("constructor") ?? node);
          for (const child of childrenOf(node)) visit(child);
          return;
        }
        case "object_creation_expression": {
          const typeNode = node.childForFieldName("type");
          if (typeNode !== null) {
            out.addEdge("calls", typeNode.text, typeNode);
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
