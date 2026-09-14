import type { Node, Tree } from "web-tree-sitter";
import { Extractor, childOfType, childrenOf, childrenOfType, lastIdentifier } from "./util.js";
import type { AdapterOutput, LanguageAdapter } from "./adapter.js";
import { collectBindings } from "./bindings.js";

const FUNCTION_VALUE_NODES = new Set([
  "function_expression",
  "arrow_function",
  "function",
  "generator_function",
  "function_signature",
]);

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

type ScopeKind = "module" | "class" | "function";

interface ScopeFrame {
  readonly name: string;
  readonly kind: ScopeKind;
}

class TsExtractor {
  readonly out = new Extractor();
  private readonly frames: ScopeFrame[] = [{ name: "", kind: "module" }];

  get inFunctionScope(): boolean {
    return this.frames.some((frame) => frame.kind === "function");
  }

  get atModuleLevel(): boolean {
    return this.frames.length === 1;
  }

  pushFrame(name: string, kind: ScopeKind): void {
    this.frames.push({ name, kind });
    this.out.push(name);
  }

  popFrame(): void {
    this.frames.pop();
    this.out.pop();
  }

  def(name: string, kind: Parameters<Extractor["addDef"]>[1], node: Node, sigNode?: Node): void {
    if (this.inFunctionScope || !IDENTIFIER_RE.test(name)) return;
    this.out.addDef(name, kind, node, sigNode);
  }
}

function declarationName(node: Node): string | null {
  const nameNode = node.childForFieldName("name");
  return nameNode !== null ? nameNode.text : null;
}

function callTarget(node: Node): string | null {
  const fn = node.childForFieldName("function");
  if (fn === null) return null;
  if (fn.type === "identifier") return fn.text;
  if (fn.type === "member_expression") {
    const prop = fn.childForFieldName("property");
    return prop !== null ? prop.text : null;
  }
  return lastIdentifier(fn);
}

function newTarget(node: Node): string | null {
  const ctor = node.childForFieldName("constructor");
  if (ctor === null) return null;
  if (ctor.type === "identifier") return ctor.text;
  if (ctor.type === "member_expression") {
    const prop = ctor.childForFieldName("property");
    return prop !== null ? prop.text : null;
  }
  return null;
}

function stringFragmentOf(node: Node): string | null {
  if (node.type === "string_fragment") return node.text;
  const fragment = childOfType(node, "string_fragment");
  return fragment !== null ? fragment.text : null;
}

function handleVariableDeclaration(node: Node, ex: TsExtractor): void {
  const isConst = node.text.startsWith("const");
  for (const declarator of childrenOfType(node, "variable_declarator")) {
    const nameNode = declarator.childForFieldName("name");
    const valueNode = declarator.childForFieldName("value");
    if (nameNode === null || nameNode.type !== "identifier") continue;
    const name = nameNode.text;
    if (valueNode !== null && FUNCTION_VALUE_NODES.has(valueNode.type)) {
      ex.def(name, "function", declarator, valueNode);
      continue;
    }
    if (valueNode !== null && (valueNode.type === "class" || valueNode.type === "class_expression")) {
      ex.def(name, "class", declarator, valueNode);
      continue;
    }
    if (isConst && ex.atModuleLevel && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
      ex.def(name, "constant", declarator, declarator);
    }
  }
}

function handleClass(node: Node, name: string, ex: TsExtractor, visit: (n: Node) => void): void {
  ex.def(name, "class", node);
  ex.pushFrame(name, "class");
  for (const child of childrenOf(node)) {
    if (child.type === "class_body" || child.type === "declaration_list") {
      for (const member of childrenOf(child)) {
        if (member.type === "method_definition") {
          const methodName = declarationName(member);
          if (methodName !== null && IDENTIFIER_RE.test(methodName)) {
            ex.out.addDef(methodName, "method", member);
            ex.pushFrame(methodName, "function");
            for (const bodyPart of childrenOf(member)) visit(bodyPart);
            ex.popFrame();
          } else {
            for (const bodyPart of childrenOf(member)) visit(bodyPart);
          }
        } else {
          visit(member);
        }
      }
    } else {
      visit(child);
    }
  }
  ex.popFrame();
}

export function makeTsLikeAdapter(language: "typescript" | "tsx" | "javascript"): LanguageAdapter {
  const extract = (tree: Tree): AdapterOutput => {
    const ex = new TsExtractor();
    const bindings = collectBindings(tree.rootNode, false);
    const visit = (node: Node): void => {
      switch (node.type) {
        case "import_statement": {
          const source = node.childForFieldName("source");
          if (source !== null) {
            const spec = stringFragmentOf(source);
            if (spec !== null && spec.length > 0) {
              ex.out.addEdge("imports", spec, node);
            }
          }
          return;
        }
        case "export_statement": {
          const source = node.childForFieldName("source");
          if (source !== null) {
            const spec = stringFragmentOf(source);
            if (spec !== null && spec.length > 0) ex.out.addEdge("imports", spec, node);
          }
          for (const child of childrenOf(node)) visit(child);
          return;
        }
        case "function_declaration":
        case "generator_function_declaration": {
          const name = declarationName(node);
          if (name !== null) ex.def(name, "function", node);
          ex.pushFrame(name ?? "", "function");
          for (const child of childrenOf(node)) visit(child);
          ex.popFrame();
          return;
        }
        case "class_declaration":
        case "abstract_class_declaration": {
          const name = declarationName(node);
          if (name !== null) {
            handleClass(node, name, ex, visit);
            return;
          }
          for (const child of childrenOf(node)) visit(child);
          return;
        }
        case "interface_declaration": {
          const name = declarationName(node);
          if (name !== null) ex.def(name, "interface", node);
          return;
        }
        case "type_alias_declaration": {
          const name = declarationName(node);
          if (name !== null) ex.def(name, "type", node);
          return;
        }
        case "enum_declaration": {
          const name = declarationName(node);
          if (name !== null) ex.def(name, "enum", node);
          return;
        }
        case "lexical_declaration":
        case "variable_declaration": {
          handleVariableDeclaration(node, ex);
          for (const child of childrenOf(node)) visit(child);
          return;
        }
        case "decorator": {
          const inner = childrenOf(node)[0];
          if (inner !== undefined) {
            const name = inner.type === "identifier" ? inner.text : lastIdentifier(inner);
            if (name !== null) ex.out.addEdge("references", name, node);
          }
          return;
        }
        case "variable_declarator": {
          const value = node.childForFieldName("value");
          const name = node.childForFieldName("name");
          if (ex.atModuleLevel && name?.type === "identifier" && value !== null && FUNCTION_VALUE_NODES.has(value.type)) {
            ex.pushFrame(name.text, "function");
            visit(value);
            ex.popFrame();
          } else {
            for (const child of childrenOf(node)) visit(child);
          }
          return;
        }
        case "call_expression": {
          const fn = node.childForFieldName("function");
          if (
            fn !== null &&
            fn.type === "identifier" &&
            (fn.text === "require" || fn.text === "import")
          ) {
            const args = node.childForFieldName("arguments");
            if (args !== null) {
              const first = childrenOf(args)[0];
              if (first !== undefined && first.type === "string") {
                const spec = stringFragmentOf(first);
                if (spec !== null && spec.length > 0) {
                  ex.out.addEdge("imports", spec, node);
                  return;
                }
              }
            }
            return;
          }
          const target = callTarget(node);
          if (target !== null) ex.out.addEdge("calls", target, node, bindings.at(fn, node));
          for (const child of childrenOf(node)) visit(child);
          return;
        }
        case "new_expression": {
          const target = newTarget(node);
          if (target !== null) ex.out.addEdge("calls", target, node, bindings.at(node.childForFieldName("constructor"), node));
          for (const child of childrenOf(node)) visit(child);
          return;
        }
        default: {
          for (const child of childrenOf(node)) visit(child);
        }
      }
    };
    for (const child of childrenOf(tree.rootNode)) visit(child);
    return { definitions: ex.out.definitions.map((definition) => ({
      ...definition, exportedNames: bindings.exportedNames(definition.name, definition.parent),
    })), edges: ex.out.edges };
  };
  return { language, extract };
}
