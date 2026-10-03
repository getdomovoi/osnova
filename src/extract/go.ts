import type { Node } from "web-tree-sitter";
import { Extractor, childrenOf } from "./util.js";
import type { AdapterOutput, LanguageAdapter } from "./adapter.js";
import { collectTypedBindings, goSpec } from "./typed-bindings.js";

const GO_TYPE_NAMES = new Set([
  "bool", "byte", "complex64", "complex128", "error", "float32", "float64",
  "int", "int8", "int16", "int32", "int64", "rune", "string", "uint", "uint8",
  "uint16", "uint32", "uint64", "uintptr", "any",
]);

// The names a node declares into the scope that holds it: the left of `:=` (in a statement, a for clause, a range clause or a
// receive case), every name of a `var`, `const` or `type` declaration, and every name of a parameter, result or
// receiver list, whatever its type. A nested block or statement declares nothing outside itself.
function declaredNames(node: Node): string[] {
  const identifiers = (list: Node | null): string[] => list === null ? [] : list.type === "identifier" ? [list.text] : childrenOf(list).filter((child) => child.type === "identifier").map((child) => child.text);
  // `:=` is an anonymous token, which the named children leave out.
  const defines = (holder: Node): boolean => holder.children.some((child) => child?.type === ":=");
  switch (node.type) {
    case "short_var_declaration":
      return identifiers(node.childForFieldName("left"));
    case "range_clause":
    case "receive_statement":
      return defines(node) ? identifiers(node.childForFieldName("left")) : [];
    case "for_clause":
      return childrenOf(node).flatMap(declaredNames);
    case "var_declaration":
    case "const_declaration":
    case "type_declaration":
    case "var_spec_list":
      return childrenOf(node).flatMap(declaredNames);
    case "var_spec":
    case "const_spec":
    case "type_spec":
    case "type_alias":
    case "parameter_declaration":
    case "variadic_parameter_declaration":
      return node.childrenForFieldName("name").flatMap((name) => name === null ? [] : [name.text]);
    case "parameter_list":
      return childrenOf(node).flatMap(declaredNames);
    // A label makes no block: the statement it marks declares into the block that holds it.
    case "labeled_statement":
      return childrenOf(node).filter((child) => child.type !== "label_name").flatMap(declaredNames);
    default:
      return [];
  }
}

// Whether a local, parameter, named result or receiver binds the name at the site: Go scopes a local from its declaration
// to the end of its block, and a function's parameters and results to its body, so each enclosing node's children before
// the one that holds the site are the declarations in scope.
function locallyBound(site: Node, name: string): boolean {
  for (let holder: Node = site, scope = site.parent; scope !== null && scope.type !== "source_file"; holder = scope, scope = scope.parent) {
    for (const child of childrenOf(scope)) {
      if (child.startIndex >= holder.startIndex) break;
      if (declaredNames(child).includes(name)) return true;
    }
    // A type switch's guard (`switch v := x.(type)`) declares `v` in each of its case clauses.
    if (scope.type === "type_switch_statement" && holder.type === "type_case") {
      const alias = scope.childForFieldName("alias");
      if (alias !== null && childrenOf(alias).some((child) => child.type === "identifier" && child.text === name)) return true;
    }
  }
  return false;
}

function receiverTypeName(node: Node): string | null {
  const params = node.childForFieldName("receiver");
  if (params === null) return null;
  const fieldDecl = childrenOf(params)[0];
  if (fieldDecl === undefined) return null;
  const typeNode = fieldDecl.childForFieldName("type") ?? childrenOf(fieldDecl)[childrenOf(fieldDecl).length - 1];
  if (typeNode === undefined) return null;
  let current: Node | null = typeNode;
  while (current !== null && (current.type === "pointer_type" || current.type === "generic_type" || current.type === "parenthesized_type")) current = current.childForFieldName("type") ?? childrenOf(current)[0] ?? null;
  return current?.type === "type_identifier" ? current.text : null;
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
            out.addDef(nameNode.text, "function", node, undefined, undefined, undefined, undefined, bindings.returns(node), bindings.returnTuple(node), undefined, undefined, bindings.elements(node), undefined, bindings.values(node));
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
            out.addDef(nameNode.text, "method", node, undefined, "instance", undefined, undefined, bindings.returns(node), bindings.returnTuple(node), undefined, undefined, bindings.elements(node), undefined, bindings.values(node));
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
              const structBody = typeNode.type === "struct_type" ? childrenOf(typeNode).find((child) => child.type === "field_declaration_list") : undefined;
              out.addDef(nameNode.text, kind, spec, undefined, undefined, undefined, undefined, undefined, undefined, structBody === undefined ? undefined : bindings.fieldTypes(childrenOf(structBody)), undefined, undefined, structBody === undefined ? undefined : bindings.elementTypes(childrenOf(structBody)), undefined, structBody === undefined ? undefined : bindings.valueTypes(childrenOf(structBody)));
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
              // A local variable or parameter holding a function shadows a package function of the same name.
              if (!GO_TYPE_NAMES.has(fn.text)) out.addEdge("calls", fn.text, fn, locallyBound(node, fn.text) ? { kind: "blocked", reason: "local-value" } : undefined);
            } else if (fn.type === "selector_expression") {
              const field = fn.childForFieldName("field");
              if (field !== null && !GO_TYPE_NAMES.has(field.text)) {
                out.addEdge("calls", field.text, field, bindings.at(fn, node));
              }
            } else if (fn.type === "parenthesized_expression") {
              const inner = childrenOf(fn)[0];
              if (inner !== undefined && inner.type === "identifier" && !GO_TYPE_NAMES.has(inner.text)) {
                out.addEdge("calls", inner.text, inner, locallyBound(node, inner.text) ? { kind: "blocked", reason: "local-value" } : undefined);
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
