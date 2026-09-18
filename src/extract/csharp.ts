import type { Node } from "web-tree-sitter";
import { Extractor, childOfType, childrenOf } from "./util.js";
import type { AdapterOutput, LanguageAdapter } from "./adapter.js";
import { collectTypedBindings, csharpSpec } from "./typed-bindings.js";

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const csharpAdapter: LanguageAdapter = {
  language: "c_sharp",
  extract(tree, _source): AdapterOutput {
    const out = new Extractor();
    const bindings = collectTypedBindings(tree.rootNode, csharpSpec);

    const visit = (node: Node): void => {
      switch (node.type) {
        case "class_declaration":
        case "interface_declaration":
        case "struct_declaration":
        case "enum_declaration":
        case "record_declaration": {
          const nameNode = node.childForFieldName("name");
          if (nameNode === null || !IDENTIFIER_RE.test(nameNode.text)) return;
          const kind =
            node.type === "interface_declaration"
              ? "interface"
              : node.type === "enum_declaration"
                ? "enum"
                : node.type === "struct_declaration"
                  ? "struct"
                  : "class";
          out.addDef(nameNode.text, kind, node, undefined, undefined, node.type === "class_declaration" || node.type === "record_declaration" ? bindings.heritage(node) : undefined, undefined, undefined, undefined, bindings.fieldTypes(childrenOf(node.childForFieldName("body") ?? node)));
          out.push(nameNode.text);
          for (const child of childrenOf(node)) visit(child);
          out.pop();
          return;
        }
        case "method_declaration":
        case "constructor_declaration": {
          const nameNode = node.childForFieldName("name");
          if (nameNode !== null && IDENTIFIER_RE.test(nameNode.text)) {
            out.addDef(nameNode.text, "method", node, undefined, bindings.memberKind(node), undefined, undefined, bindings.returns(node));
            out.push(nameNode.text);
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
          if (fn !== null) {
            if (fn.type === "identifier") {
              out.addEdge("calls", fn.text, node);
            } else if (fn.type === "member_access_expression") {
              const nameNode = fn.childForFieldName("name");
              if (nameNode !== null) out.addEdge("calls", nameNode.text, node, bindings.at(fn, node));
            }
          }
          for (const child of childrenOf(node)) visit(child);
          return;
        }
        case "object_creation_expression": {
          const typeNode = node.childForFieldName("type");
          if (typeNode !== null) out.addEdge("calls", typeNode.text, node);
          for (const child of childrenOf(node)) visit(child);
          return;
        }
        case "using_directive": {
          const nameNode = node.childForFieldName("name");
          const namespaceNode = nameNode ?? childrenOf(node)[0];
          if (namespaceNode !== null && namespaceNode !== undefined) {
            out.addEdge("imports", namespaceNode.text, node);
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
