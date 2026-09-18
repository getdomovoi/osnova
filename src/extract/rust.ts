import type { Node } from "web-tree-sitter";
import { Extractor, childrenOf } from "./util.js";
import type { AdapterOutput, LanguageAdapter } from "./adapter.js";
import { collectTypedBindings, rustSpec } from "./typed-bindings.js";

function lastSegment(text: string): string {
  const parts = text.split("::");
  return parts[parts.length - 1] ?? text;
}

function implTypeName(node: Node): string | null {
  const typeNode = node.childForFieldName("type");
  if (typeNode === null) return null;
  if (typeNode.type === "type_identifier") return typeNode.text;
  if (typeNode.type === "generic_type" || typeNode.type === "scoped_type_identifier") {
    const id = childrenOf(typeNode).find((c) => c.type === "type_identifier");
    return id !== undefined ? id.text : null;
  }
  return null;
}

export const rustAdapter: LanguageAdapter = {
  language: "rust",
  extract(tree, _source): AdapterOutput {
    const out = new Extractor();
    const bindings = collectTypedBindings(tree.rootNode, rustSpec);

    const visit = (node: Node): void => {
      switch (node.type) {
        case "function_item": {
          const nameNode = node.childForFieldName("name");
          if (nameNode !== null) {
            const inTrait = node.parent?.type === "declaration_list" && node.parent?.parent?.type === "trait_item";
            out.addDef(nameNode.text, hasImplAncestor(node) || inTrait ? "method" : "function", node, undefined, bindings.memberKind(node), undefined, undefined, bindings.returns(node));
            out.push(nameNode.text);
            for (const child of childrenOf(node)) visit(child);
            out.pop();
          }
          return;
        }
        case "function_signature_item": {
          const nameNode = node.childForFieldName("name");
          if (nameNode !== null) out.addDef(nameNode.text, "method", node);
          return;
        }
        case "struct_item": {
          const nameNode = node.childForFieldName("name");
          if (nameNode !== null) out.addDef(nameNode.text, "struct", node, undefined, undefined, undefined, undefined, undefined, undefined, bindings.fieldTypes(childrenOf(node.childForFieldName("body") ?? node)));
          return;
        }
        case "enum_item": {
          const nameNode = node.childForFieldName("name");
          if (nameNode !== null) out.addDef(nameNode.text, "enum", node);
          return;
        }
        case "trait_item": {
          const nameNode = node.childForFieldName("name");
          if (nameNode !== null) {
            out.addDef(nameNode.text, "trait", node);
            out.push(nameNode.text);
            for (const child of childrenOf(node)) visit(child);
            out.pop();
          }
          return;
        }
        case "type_item": {
          const nameNode = node.childForFieldName("name");
          if (nameNode !== null) out.addDef(nameNode.text, "type", node);
          return;
        }
        case "const_item":
        case "static_item": {
          const nameNode = node.childForFieldName("name");
          if (nameNode !== null) out.addDef(nameNode.text, "constant", node);
          return;
        }
        case "impl_item": {
          const typeName = implTypeName(node);
          const traitNode = node.childForFieldName("trait");
          const traitName = traitNode === null ? null : traitNode.type === "type_identifier" ? traitNode.text : childrenOf(traitNode).find((c) => c.type === "type_identifier")?.text ?? null;
          if (typeName !== null) {
            // A trait implementation is indexed under Type.Trait so receiver lookup, which sees Type.member, treats only inherent methods as members.
            out.push(traitName === null ? typeName : `${typeName}.${traitName}`);
            for (const child of childrenOf(node)) visit(child);
            out.pop();
          } else {
            for (const child of childrenOf(node)) visit(child);
          }
          return;
        }
        case "call_expression": {
          const fn = node.childForFieldName("function");
          if (fn !== null) {
            if (fn.type === "identifier") {
              out.addEdge("calls", fn.text, node);
            } else if (fn.type === "scoped_identifier" || fn.type === "scoped_type_identifier") {
              const name = fn.childForFieldName("name")?.text ?? lastSegment(fn.text);
              if (/^[A-Za-z_]\w*$/.test(name)) out.addEdge("calls", name, node, bindings.at(fn, node));
            } else if (fn.type === "field_expression") {
              const field = fn.childForFieldName("field");
              if (field !== null) out.addEdge("calls", field.text, node, bindings.at(fn, node));
            } else if (fn.type === "generic_function") {
              const inner = fn.childForFieldName("function");
              if (inner !== null) {
                const name = inner.type === "identifier" ? inner.text : inner.childForFieldName("name")?.text ?? lastSegment(inner.text);
                if (/^[A-Za-z_]\w*$/.test(name)) out.addEdge("calls", name, node, bindings.at(inner, node));
              }
            }
          }
          for (const child of childrenOf(node)) visit(child);
          return;
        }
        case "macro_invocation": {
          const macro = node.childForFieldName("macro");
          if (macro !== null) out.addEdge("references", macro.text, node);
          return;
        }
        case "use_declaration": {
          const arg = childrenOf(node).find((c) => c.type !== "visibility_modifier");
          if (arg !== undefined && arg.type !== "use_wildcard") {
            out.addEdge("imports", arg.text, node);
          } else if (arg !== undefined) {
            out.addEdge("imports", arg.text, node);
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

function hasImplAncestor(node: Node): boolean {
  let cur: Node | null = node.parent;
  while (cur !== null) {
    if (cur.type === "impl_item") return true;
    cur = cur.parent;
  }
  return false;
}
