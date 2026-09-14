import type { Node } from "web-tree-sitter";
import { Extractor, childOfType, childrenOf } from "./util.js";
import type { AdapterOutput, LanguageAdapter } from "./adapter.js";
import { collectBindings } from "./bindings.js";

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function nameField(node: Node): string | null {
  const nameNode = node.childForFieldName("name");
  return nameNode !== null ? nameNode.text : null;
}

function callTarget(node: Node): string | null {
  const fn = node.childForFieldName("function");
  if (fn === null) return null;
  if (fn.type === "identifier") return fn.text;
  if (fn.type === "attribute") {
    const attr = fn.childForFieldName("attribute");
    return attr !== null ? attr.text : null;
  }
  return null;
}

export const pythonAdapter: LanguageAdapter = {
  language: "python",
  extract(tree, _source): AdapterOutput {
    const out = new Extractor();
    const bindings = collectBindings(tree.rootNode, true);
    let inClassDepth = 0;

    const addConstant = (node: Node, name: string): void => {
      if (inClassDepth === 0 && out.enclosing === "" && /^[A-Z][A-Z0-9_]*$/.test(name) && name.length >= 2) {
        out.addDef(name, "constant", node);
      }
    };

    const visit = (node: Node): void => {
      switch (node.type) {
        case "decorated_definition": {
          const defNode = childOfType(node, "function_definition") ?? childOfType(node, "class_definition");
          if (defNode !== null) {
            const decos = childrenOf(node).filter((c) => c.type === "decorator");
            visit(defNode);
            for (const deco of decos) {
              const inner = childrenOf(deco)[0];
              if (inner === undefined) continue;
              const name =
                inner.type === "identifier"
                  ? inner.text
                  : inner.type === "call"
                    ? callTarget(inner)
                    : inner.type === "attribute"
                      ? (inner.childForFieldName("attribute")?.text ?? null)
                      : null;
              if (name !== null && name.length > 0) out.addEdge("references", name, deco);
            }
          }
          return;
        }
        case "function_definition": {
          const name = nameField(node);
          const isMethod = inClassDepth > 0;
          if (name !== null && IDENTIFIER_RE.test(name)) {
            out.addDef(name, isMethod ? "method" : "function", node);
            out.push(name);
            const pushDepth = inClassDepth;
            if (isMethod) inClassDepth = 0;
            for (const child of childrenOf(node)) visit(child);
            inClassDepth = pushDepth;
            out.pop();
          } else {
            for (const child of childrenOf(node)) visit(child);
          }
          return;
        }
        case "class_definition": {
          const name = nameField(node);
          if (name !== null && IDENTIFIER_RE.test(name)) {
            out.addDef(name, "class", node);
            out.push(name);
            inClassDepth += 1;
            for (const child of childrenOf(node)) visit(child);
            inClassDepth -= 1;
            out.pop();
          } else {
            for (const child of childrenOf(node)) visit(child);
          }
          return;
        }
        case "assignment": {
          const left = node.childForFieldName("left");
          if (left !== null && left.type === "identifier") addConstant(node, left.text);
          for (const child of childrenOf(node)) visit(child);
          return;
        }
        case "call": {
          const target = callTarget(node);
          if (target !== null) out.addEdge("calls", target, node, bindings.at(node.childForFieldName("function"), node));
          for (const child of childrenOf(node)) visit(child);
          return;
        }
        case "import_statement": {
          for (const child of childrenOf(node)) {
            if (child.type === "dotted_name" || child.type === "aliased_import") {
              out.addEdge("imports", child.type === "aliased_import" ? child.childForFieldName("name")?.text ?? child.text : child.text, child);
            }
          }
          return;
        }
        case "import_from_statement": {
          const moduleNode = node.childForFieldName("module_name");
          if (moduleNode !== null) {
            out.addEdge("imports", moduleNode.text, moduleNode);
          } else {
            for (const child of childrenOf(node)) {
              if (child.type === "relative_import") out.addEdge("imports", child.text, child);
            }
          }
          for (const child of childrenOf(node)) {
            if (child.id === moduleNode?.id || child.type === "relative_import") continue;
            if (child.type === "wildcard_import") continue;
            if (child.type === "dotted_name" || child.type === "aliased_import") {
              const imported = child.text.split(" as ")[0]?.trim() ?? child.text;
              const name = imported.split(".").pop() ?? imported;
              out.addEdge("references", name, child);
            }
          }
          return;
        }
        case "wildcard_import": {
          return;
        }
        default: {
          for (const child of childrenOf(node)) visit(child);
        }
      }
    };
    for (const child of childrenOf(tree.rootNode)) visit(child);
    return { definitions: out.definitions.map((definition) => ({
      ...definition, exportedNames: bindings.exportedNames(definition.name, definition.parent),
    })), edges: out.edges };
  },
};
