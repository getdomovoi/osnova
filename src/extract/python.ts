import type { Node } from "web-tree-sitter";
import { Extractor, childOfType, childrenOf } from "./util.js";
import type { AdapterOutput, LanguageAdapter } from "./adapter.js";
import { collectBindings } from "./bindings.js";
import { frameworkOfReceiver, isMount, routeInfo, routeMethod } from "./routes.js";
import type { EdgeBinding } from "../types.js";

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

// A plain string is a route path; an f-string or a concatenation is computed and records none.
function literalPath(node: Node | undefined): string | undefined {
  if (node === undefined || node.type !== "string") return undefined;
  const parts = childrenOf(node);
  if (parts.some((part) => part.type === "interpolation") || /[fF]/.test(parts.find((part) => part.type === "string_start")?.text ?? "")) return undefined;
  return parts.filter((part) => part.type === "string_content").map((part) => part.text).join("");
}

function keywordArgument(args: Node | null, name: string): Node | undefined {
  if (args === null) return undefined;
  for (const arg of childrenOf(args)) {
    if (arg.type === "keyword_argument" && arg.childForFieldName("name")?.text === name) return arg.childForFieldName("value") ?? undefined;
  }
  return undefined;
}

function routeHandler(node: Node, site: Node, bindings: ReturnType<typeof collectBindings>): { name: string; binding: EdgeBinding } {
  if (node.type === "identifier") {
    const declared = bindings.declaredName(node.text, site);
    return { name: node.text, binding: bindings.boundValue(node.text, site) ?? (declared === undefined ? { kind: "blocked", reason: "unbound" } : { kind: "local", name: declared }) };
  }
  if (node.type === "attribute") return { name: node.childForFieldName("attribute")?.text ?? node.text, binding: bindings.at(node, site) ?? { kind: "blocked", reason: "unknown-receiver" } };
  if (node.type === "lambda") return { name: "(inline)", binding: { kind: "blocked", reason: "inline-handler" } };
  return { name: "(wrapped)", binding: { kind: "blocked", reason: "wrapped-handler" } };
}

function valuePosition(node: Node): boolean {
  let child = node;
  let parent = node.parent;
  while (parent !== null && parent.type === "parenthesized_expression") { child = parent; parent = parent.parent; }
  if (parent === null) return false;
  const inField = (field: string): boolean => parent.childForFieldName(field)?.id === child.id;
  switch (parent.type) {
    case "argument_list": return parent.parent?.type === "call";
    case "list": case "tuple": case "set": case "expression_list": case "return_statement": case "interpolation": return true;
    case "keyword_argument": case "pair": case "default_parameter": case "typed_default_parameter": return inField("value");
    case "assignment": case "augmented_assignment": return inField("right");
    case "boolean_operator": return true;
    case "conditional_expression": { const parts = childrenOf(parent); return parts[0]?.id === child.id || parts[2]?.id === child.id; }
    default: return false;
  }
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
              if (inner.type === "call") {
                const target = callTarget(inner);
                const callee = bindings.at(inner.childForFieldName("function"), inner);
                if (target !== null) out.addEdge("calls", target, inner, callee);
                const framework = frameworkOfReceiver(callee);
                const method = framework === undefined || target === null || isMount(framework, target) ? undefined : routeMethod(framework, target);
                const defName = nameField(defNode);
                if (method !== undefined && defName !== null && IDENTIFIER_RE.test(defName)) {
                  const args = childrenOf(inner.childForFieldName("arguments") ?? inner);
                  out.addEdge("routes", defName, deco, { kind: "local", name: out.enclosing === "" ? defName : `${out.enclosing}.${defName}` }, routeInfo(method, literalPath(args[0])));
                }
                for (const arg of childrenOf(inner.childForFieldName("arguments") ?? inner)) visit(arg);
                continue;
              }
              const name =
                inner.type === "identifier"
                  ? inner.text
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
            out.addDef(name, isMethod ? "method" : "function", node, undefined, isMethod ? bindings.memberKind(node) : undefined, undefined, undefined, bindings.returns(node), undefined, undefined, bindings.unwrapped(node), bindings.elements(node), undefined, bindings.values(node));
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
            out.addDef(name, "class", node, undefined, undefined, bindings.heritage(node), bindings.ownFields(node), undefined, undefined, bindings.fieldTypes(node), undefined, undefined, bindings.elementTypes(node), undefined, bindings.valueTypes(node));
            out.push(name);
            for (const base of bindings.heritageRefs(node)) out.addEdge("extends", base.name, base.node, base.binding);
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
          const callee = bindings.at(node.childForFieldName("function"), node);
          if (target !== null) out.addEdge("calls", target, node, callee);
          const framework = frameworkOfReceiver(callee);
          if (framework !== undefined && target !== null && isMount(framework, target)) {
            const argList = node.childForFieldName("arguments");
            const positional = childrenOf(argList ?? node).filter((arg) => arg.type !== "keyword_argument");
            if (target === "add_url_rule") {
              // add_url_rule(rule, endpoint=None, view_func=None): the view is the keyword or the third positional argument.
              const view = keywordArgument(argList, "view_func") ?? positional[2];
              if (view !== undefined) { const handler = routeHandler(view, node, bindings); out.addEdge("routes", handler.name, node, handler.binding, routeInfo("ANY", literalPath(positional[0]))); }
            } else if (positional[0] !== undefined) {
              const handler = routeHandler(positional[0], node, bindings);
              out.addEdge("routes", handler.name, node, handler.binding, routeInfo("ANY", literalPath(keywordArgument(argList, target === "include_router" ? "prefix" : "url_prefix"))));
            }
          }
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
        case "identifier": {
          if (!valuePosition(node)) return;
          const binding = bindings.boundValue(node.text, node);
          if (binding !== undefined) out.addEdge("references", node.text, node, binding);
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
    })), edges: out.edges, reExports: bindings.reExports };
  },
};
