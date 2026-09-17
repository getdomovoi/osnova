import type { Node } from "web-tree-sitter";
import { Extractor, childrenOf } from "./util.js";
import type { AdapterOutput, LanguageAdapter } from "./adapter.js";
import { collectTypedBindings, goSpec } from "./typed-bindings.js";

const GO_TYPE_NAMES = new Set([
  "bool", "byte", "complex64", "complex128", "error", "float32", "float64",
  "int", "int8", "int16", "int32", "int64", "rune", "string", "uint", "uint8",
  "uint16", "uint32", "uint64", "uintptr", "any",
]);

function receiverTypeName(node: Node): string | null {
  const params = node.childForFieldName("receiver");
  if (params === null) return null;
  const fieldDecl = childrenOf(params)[0];
  if (fieldDecl === undefined) return null;
  const typeNode = fieldDecl.childForFieldName("type") ?? childrenOf(fieldDecl)[childrenOf(fieldDecl).length - 1];
  if (typeNode === undefined) return null;
  if (typeNode.type === "type_identifier") return typeNode.text;
  if (typeNode.type === "pointer_type" || typeNode.type === "generic_type") {
    const id = childrenOf(typeNode).find((c) => c.type === "type_identifier");
    return id !== undefined ? id.text : null;
  }
  return null;
}

export const goAdapter: LanguageAdapter = {
  language: "go",
  extract(tree, _source): AdapterOutput {
    const out = new Extractor();
    const bindings = collectTypedBindings(tree.rootNode, goSpec);

    const visit = (node: Node): void => {
      switch (node.type) {
        case "function_declaration": {
          const nameNode = node.childForFieldName("name");
          if (nameNode !== null) {
            out.addDef(nameNode.text, "function", node, undefined, undefined, undefined, undefined, bindings.returns(node));
            out.push(nameNode.text);
            for (const child of childrenOf(node)) visit(child);
            out.pop();
          }
          return;
        }
        case "method_declaration": {
          const nameNode = node.childForFieldName("name");
          const recv = receiverTypeName(node);
          if (nameNode !== null && recv !== null) {
            out.push(recv);
            out.addDef(nameNode.text, "method", node, undefined, "instance", undefined, undefined, bindings.returns(node));
            out.push(nameNode.text);
            for (const child of childrenOf(node)) visit(child);
            out.pop();
            out.pop();
          } else {
            for (const child of childrenOf(node)) visit(child);
          }
          return;
        }
        case "type_declaration": {
          for (const spec of childrenOf(node)) {
            if (spec.type === "type_spec" || spec.type === "type_spec_group") {
              const nameNode = spec.childForFieldName("name");
              const typeNode = spec.childForFieldName("type");
              if (nameNode === null || typeNode === null) continue;
              const kind =
                typeNode.type === "struct_type"
                  ? "struct"
                  : typeNode.type === "interface_type"
                    ? "interface"
                    : "type";
              out.addDef(nameNode.text, kind, spec);
              if (typeNode.type === "interface_type") {
                out.push(nameNode.text);
                for (const member of childrenOf(typeNode)) {
                  if (member.type !== "method_spec" && member.type !== "method_elem") continue;
                  const methodName = member.childForFieldName("name");
                  if (methodName !== null) out.addDef(methodName.text, "method", member, undefined, "instance", undefined, undefined, bindings.returns(member));
                }
                out.pop();
              }
            }
          }
          return;
        }
        case "const_declaration": {
          for (const spec of childrenOf(node)) {
            if (spec.type !== "const_spec") continue;
            for (const id of childrenOf(spec)) {
              if (id.type === "identifier") out.addDef(id.text, "constant", spec);
            }
          }
          return;
        }
        case "call_expression": {
          const fn = node.childForFieldName("function");
          if (fn !== null) {
            if (fn.type === "identifier") {
              if (!GO_TYPE_NAMES.has(fn.text)) out.addEdge("calls", fn.text, node);
            } else if (fn.type === "selector_expression") {
              const field = fn.childForFieldName("field");
              if (field !== null && !GO_TYPE_NAMES.has(field.text)) {
                out.addEdge("calls", field.text, node, bindings.at(fn, node));
              }
            } else if (fn.type === "parenthesized_expression") {
              const inner = childrenOf(fn)[0];
              if (inner !== undefined && inner.type === "identifier" && !GO_TYPE_NAMES.has(inner.text)) {
                out.addEdge("calls", inner.text, node);
              }
            }
          }
          for (const child of childrenOf(node)) visit(child);
          return;
        }
        case "import_declaration": {
          const specs = childrenOf(node).filter(
            (c) => c.type === "import_spec" || c.type === "import_spec_list",
          );
          for (const spec of specs) {
            if (spec.type === "import_spec") {
              const pathNode = spec.childForFieldName("path");
              if (pathNode !== null) {
                out.addEdge("imports", pathNode.text.replace(/^["'`]|["'`]$/g, ""), spec);
              }
            } else {
              for (const inner of childrenOf(spec)) {
                if (inner.type === "import_spec") {
                  const pathNode = inner.childForFieldName("path");
                  if (pathNode !== null) {
                    out.addEdge("imports", pathNode.text.replace(/^["'`]|["'`]$/g, ""), inner);
                  }
                }
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
    return { definitions: out.definitions, edges: out.edges };
  },
};
