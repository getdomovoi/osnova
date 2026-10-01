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

function parameterRange(list: Node, method: Node): ParameterRange {
  const overrides = annotatedOverride(method);
  const access = accessOf(method);
  let count = 0;
  let varargs = false;
  for (const child of childrenOf(list)) {
    if (child.type === "formal_parameter") count += 1;
    else if (child.type === "spread_parameter") varargs = true;
  }
  return { min: count, ...(varargs ? {} : { max: count }), ...(overrides ? { overrides: true as const } : {}), ...(access === undefined ? {} : { access }) };
}

export const javaAdapter: LanguageAdapter = {
  language: "java",
  extract(tree, _source): AdapterOutput {
    const out = new Extractor();
    const bindings = collectTypedBindings(tree.rootNode, javaSpec);

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
          if (childOfType(node, "super_interfaces") !== null) out.markInterfaces();
          out.push(nameNode.text);
          for (const child of childrenOf(node)) visit(child);
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
            if (parameters !== null) out.setParameters(parameterRange(parameters, node));
            out.push(nameNode.text);
            for (const child of childrenOf(node)) visit(child);
            out.pop();
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
