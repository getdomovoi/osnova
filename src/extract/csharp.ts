import type { Node } from "web-tree-sitter";
import { Extractor, argumentCount, childOfType, childrenOf, withoutTypeArguments } from "./util.js";
import type { AdapterOutput, LanguageAdapter } from "./adapter.js";
import type { ParameterRange } from "../types.js";
import { collectTypedBindings, csharpSpec } from "./typed-bindings.js";

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// This grammar writes `params int[] rest` as a bare `params` token in the list, not as a parameter.
// A method a derived type cannot call: written `private`, or without an access modifier outside an interface.
function accessOf(method: Node): ParameterRange["access"] {
  const modifiers = new Set(childrenOf(method).filter((child) => child.type === "modifier").map((child) => child.text));
  if (modifiers.has("private") && !modifiers.has("protected")) return "private";
  if (["public", "protected", "internal", "private"].some((name) => modifiers.has(name))) return undefined;
  return method.parent?.parent?.type === "interface_declaration" ? undefined : "private";
}

function parameterRange(list: Node, method: Node, constructor = false): ParameterRange {
  const overrides = childrenOf(method).some((child) => child.type === "modifier" && child.text === "override");
  const access = accessOf(method);
  let required = 0;
  let optional = 0;
  const variadic = list.children.some((child) => child?.type === "params");
  let extension = false;
  for (const child of childrenOf(list)) {
    if (child.type !== "parameter") continue;
    if (required + optional === 0 && childrenOf(child).some((part) => part.type === "parameter_modifier" && part.text === "this")) extension = true;
    if (childOfType(child, "equals_value_clause") !== null) optional += 1;
    else required += 1;
  }
  return { min: required, ...(variadic ? {} : { max: required + optional }), ...(extension ? { extension: true as const } : {}), ...(overrides ? { overrides: true as const } : {}), ...(access === undefined ? {} : { access }), ...(constructor ? { constructs: true as const } : {}) };
}

// A parameter list written after the type's name and type parameters: a record's, or a class's or struct's
// primary constructor (C# 12), which the recovery parse leaves out of the tree but not out of the node's text.
function hasPrimaryConstructor(type: Node, name: Node): boolean {
  if (childOfType(type, "parameter_list") !== null) return true;
  const after = childOfType(type, "type_parameter_list") ?? name;
  return /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*\(/.test(type.text.slice(after.endIndex - type.startIndex));
}

export const csharpAdapter: LanguageAdapter = {
  language: "c_sharp",
  extract(tree, _source): AdapterOutput {
    const out = new Extractor();
    const bindings = collectTypedBindings(tree.rootNode, csharpSpec);

    const namespaces: string[] = [];
    // The generic arity of each enclosing type, outermost first: `Outer<T>.Inner` and `Outer<T, U>.Inner`
    // are different types with the same local name.
    const arities: number[] = [];
    const visit = (node: Node): void => {
      switch (node.type) {
        case "namespace_declaration":
        case "file_scoped_namespace_declaration": {
          const name = node.childForFieldName("name");
          if (name !== null) namespaces.push(name.text.replace(/\s+/g, "").replace(/(^|\.)@/g, "$1"));
          for (const child of childrenOf(node)) visit(child);
          if (name !== null) namespaces.pop();
          return;
        }
        case "class_declaration":
        case "interface_declaration":
        case "struct_declaration":
        case "enum_declaration":
        case "record_declaration":
        case "record_struct_declaration": {
          const nameNode = node.childForFieldName("name");
          if (nameNode === null || !IDENTIFIER_RE.test(nameNode.text)) return;
          const kind =
            node.type === "interface_declaration"
              ? "interface"
              : node.type === "enum_declaration"
                ? "enum"
                : node.type === "struct_declaration" || node.type === "record_struct_declaration"
                  ? "struct"
                  : "class";
          out.addDef(nameNode.text, kind, node, undefined, undefined, node.type === "class_declaration" || node.type === "record_declaration" || node.type === "record_struct_declaration" ? bindings.heritage(node) : undefined, undefined, undefined, undefined, bindings.fieldTypes(childrenOf(node.childForFieldName("body") ?? node)), undefined, undefined, bindings.elementTypes(childrenOf(node.childForFieldName("body") ?? node)), undefined, bindings.valueTypes(childrenOf(node.childForFieldName("body") ?? node)));
          arities.push(childrenOf(childOfType(node, "type_parameter_list") ?? node).filter((child) => child.type === "type_parameter").length);
          if (hasPrimaryConstructor(node, nameNode)) out.markPrimary();
          if (childrenOf(node).some((child) => child.type === "modifier" && child.text === "partial")) out.markPartial(`${namespaces.join(".")}\`${arities.join(".")}`);
          out.push(nameNode.text);
          for (const child of childrenOf(node)) visit(child);
          out.pop();
          arities.pop();
          return;
        }
        case "method_declaration":
        case "constructor_declaration": {
          const nameNode = node.childForFieldName("name");
          if (nameNode !== null && IDENTIFIER_RE.test(nameNode.text)) {
            out.addDef(nameNode.text, "method", node, undefined, bindings.memberKind(node), undefined, undefined, bindings.returns(node), undefined, undefined, undefined, bindings.elements(node), undefined, bindings.values(node));
            const parameters = node.childForFieldName("parameters");
            if (parameters !== null) out.setParameters(parameterRange(parameters, node, node.type === "constructor_declaration" && !childrenOf(node).some((child) => child.type === "modifier" && child.text === "static")));
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
          const args = argumentCount(node.childForFieldName("arguments"));
          if (fn !== null) {
            if (fn.type === "identifier") {
              out.addEdge("calls", fn.text, fn, undefined, undefined, args);
            } else if (fn.type === "member_access_expression") {
              const nameNode = fn.childForFieldName("name");
              if (nameNode !== null) out.addEdge("calls", nameNode.text, nameNode, bindings.at(fn, node), undefined, args);
            }
          }
          for (const child of childrenOf(node)) visit(child);
          return;
        }
        case "object_creation_expression": {
          // `new Box<string>(1)` names Box.
          const typeNode = node.childForFieldName("type");
          // `new T { Init = 1 }` without an argument list runs the parameterless constructor.
          const args = node.childForFieldName("arguments");
          if (typeNode !== null) out.addEdge("calls", withoutTypeArguments(typeNode.text), typeNode, undefined, undefined, args === null ? 0 : argumentCount(args), "instance");
          for (const child of childrenOf(node)) visit(child);
          return;
        }
        case "using_directive": {
          // An alias directive records its alias name and `=` (`X =`); comments may sit anywhere in the directive.
          const parts = childrenOf(node).filter((child) => child.type !== "comment");
          const alias = parts.find((child) => child.type === "name_equals");
          const aliasName = alias === undefined ? undefined : childrenOf(alias).find((child) => child.type === "identifier");
          const name = alias === undefined ? parts[0]?.text : aliasName === undefined ? undefined : `${aliasName.text} =`;
          if (name !== undefined) out.addEdge("imports", name, node);
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
