import type { Node } from "web-tree-sitter";
import { Extractor, childOfType, childrenOf } from "./util.js";
import type { AdapterOutput, LanguageAdapter } from "./adapter.js";

export const javaAdapter: LanguageAdapter = {
  language: "java",
  extract(tree, _source): AdapterOutput {
    const out = new Extractor();

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
          out.addDef(nameNode.text, kind, node);
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
            out.addDef(nameNode.text, "method", node);
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
          if (nameNode !== null) out.addEdge("calls", nameNode.text, node);
          for (const child of childrenOf(node)) visit(child);
          return;
        }
        case "explicit_constructor_invocation": {
          out.addEdge("calls", node.text.trimStart().startsWith("super") ? "super" : "this", node);
          for (const child of childrenOf(node)) visit(child);
          return;
        }
        case "object_creation_expression": {
          const typeNode = node.childForFieldName("type");
          if (typeNode !== null) {
            out.addEdge("calls", typeNode.text, node);
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
