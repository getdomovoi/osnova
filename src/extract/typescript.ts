import type { Node, Tree } from "web-tree-sitter";
import { Extractor, childOfType, childrenOf, childrenOfType, lastIdentifier } from "./util.js";
import type { AdapterOutput, LanguageAdapter } from "./adapter.js";
import { FIELD_NODES, FUNCTION_VALUE_NODES, collectBindings, memberKindOf } from "./bindings.js";

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

class TsExtractor {
  readonly out = new Extractor();
  constructor(readonly bindings: ReturnType<typeof collectBindings>) {}

  pushFrame(name: string): void {
    this.out.push(name);
  }

  popFrame(): void {
    this.out.pop();
  }

  def(name: string, kind: Parameters<Extractor["addDef"]>[1], node: Node, sigNode?: Node): void {
    if (!IDENTIFIER_RE.test(name)) return;
    this.out.addDef(name, kind, node, sigNode, undefined, undefined, undefined, kind === "function" ? this.bindings.returns(sigNode ?? node) : undefined, undefined, undefined, kind === "function" ? this.bindings.unwrapped(sigNode ?? node) : undefined);
  }
}

function declarationName(node: Node): string | null {
  const nameNode = node.childForFieldName("name") ?? (FIELD_NODES.has(node.type) ? node.childForFieldName("property") : null);
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
    if (isConst && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
      ex.def(name, "constant", declarator, declarator);
    }
  }
}

function handleClass(node: Node, name: string, ex: TsExtractor, visit: (n: Node) => void): void {
  ex.out.addDef(name, "class", node, undefined, undefined, ex.bindings.heritage(node), ex.bindings.ownFields(node), undefined, undefined, ex.bindings.fieldTypes(node));
  ex.pushFrame(name);
  for (const child of childrenOf(node)) {
    if (child.type === "class_body" || child.type === "declaration_list") {
      for (const member of childrenOf(child)) {
        const fieldValue = FIELD_NODES.has(member.type) ? member.childForFieldName("value") : null;
        if (member.type === "method_definition" || (fieldValue !== null && FUNCTION_VALUE_NODES.has(fieldValue.type))) {
          const methodName = declarationName(member);
          if (methodName !== null && IDENTIFIER_RE.test(methodName)) {
            ex.out.addDef(methodName, "method", member, fieldValue ?? undefined, memberKindOf(member, false), undefined, undefined, ex.bindings.returns(fieldValue ?? member), undefined, undefined, ex.bindings.unwrapped(fieldValue ?? member));
            ex.pushFrame(methodName);
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
    const bindings = collectBindings(tree.rootNode, false);
    const ex = new TsExtractor(bindings);
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
          ex.pushFrame(name ?? "");
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
          if (name !== null) {
            const fields: string[] = [];
            const methods: Node[] = [];
            for (const member of childrenOf(node.childForFieldName("body") ?? node)) {
              const methodName = member.childForFieldName("name")?.text;
              if (methodName === undefined || !IDENTIFIER_RE.test(methodName)) continue;
              const functionTyped = member.type === "property_signature" && childrenOf(member.childForFieldName("type") ?? member).some((child) => child.type === "function_type");
              if (member.type === "method_signature" || functionTyped) methods.push(member);
              else if (member.type === "property_signature") fields.push(methodName);
            }
            ex.out.addDef(name, "interface", node, undefined, undefined, ex.bindings.heritage(node), fields, undefined, undefined, ex.bindings.fieldTypes(node));
            ex.pushFrame(name);
            for (const member of methods) ex.out.addDef(member.childForFieldName("name")!.text, "method", member, undefined, "instance", undefined, undefined, ex.bindings.returns(member));
            ex.popFrame();
          }
          return;
        }
        case "internal_module":
        case "module": {
          const nameNode = node.childForFieldName("name");
          if (nameNode?.type !== "identifier") { for (const child of childrenOf(node)) visit(child); return; }
          ex.out.addDef(nameNode.text, "module", node, nameNode);
          ex.pushFrame(nameNode.text);
          for (const child of childrenOf(node.childForFieldName("body") ?? node)) visit(child);
          ex.popFrame();
          return;
        }
        case "ambient_declaration": {
          for (const child of childrenOf(node)) {
            if (child.type === "statement_block") continue;
            if (child.type === "module" && child.childForFieldName("name")?.type !== "identifier") continue;
            const signatureName = child.type === "function_signature" ? declarationName(child) : null;
            if (signatureName !== null) ex.def(signatureName, "function", child, child); else visit(child);
          }
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
          if (name?.type === "identifier" && value !== null && FUNCTION_VALUE_NODES.has(value.type)) {
            ex.pushFrame(name.text);
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
    })), edges: ex.out.edges, reExports: bindings.reExports };
  };
  return { language, extract };
}
