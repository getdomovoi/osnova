import type { Node } from "web-tree-sitter";
import type { Callee, EdgeBinding, MemberKind, ReceiverOwner, ReturnBinding, SymbolBinding } from "../types.js";
import { childrenOf } from "./util.js";

// Receiver identity for languages with declared types and no lexical binding collector of their
// own. A name is bound to a type name by a typed parameter, a typed local, a constructor literal or
// the declared return type of the call that produced it. Anything untyped is unknown. Reassignment never
// changes a binding: in these languages a name's static type is fixed for its whole lifetime.

export interface TypedSpec {
  readonly functionNodes: readonly string[];
  readonly scopeNodes: readonly string[];
  readonly parameter: (node: Node) => { name: Node; type: Node | null } | undefined;
  readonly typeName: (node: Node | null) => string | undefined;
  readonly returnType: (fn: Node) => Node | null;
  readonly returnTypes?: ((fn: Node) => readonly (Node | null)[] | undefined) | undefined;
  readonly receiver: (fn: Node) => { name: string; type: string } | undefined;
  readonly memberKind: (fn: Node) => MemberKind | undefined;
  readonly local: (node: Node) => ReadonlyArray<{ name: Node; type: Node | null; value: Node | null; index?: number | undefined }>;
  readonly constructed: (value: Node | null) => string | undefined;
  readonly callee: (fn: Node) => { object: Node | null; name: string; path?: string | undefined } | undefined;
  readonly imports: (node: Node) => ReadonlyArray<{ local: string; source: string; name: string }>;
  readonly classNodes?: readonly string[] | undefined;
  readonly field?: ((node: Node) => ReadonlyArray<{ name: string; type: Node | null; isStatic: boolean }>) | undefined;
  readonly thisNodes?: readonly string[] | undefined;
  readonly isStatic?: ((fn: Node) => boolean) | undefined;
  readonly bases?: ((classNode: Node) => readonly string[]) | undefined;
  readonly innerType?: ((type: Node) => Node | null) | undefined;
  // A declared type parameter and its bounds (`T: Runner`, `T extends Runner`, `[T Runner]`); a where or
  // constraints clause on the declaring node adds bounds by name.
  readonly typeBounds?: ((parameter: Node) => { name: string; bounds: readonly Node[] } | undefined) | undefined;
  readonly whereBounds?: ((declaration: Node, name: string) => readonly Node[]) | undefined;
  // `self.field` inside an impl block: the struct's declared field type, or, when that type is one of the
  // struct's parameters, the impl's argument in that position together with the impl node whose bounds apply.
  readonly implField?: ((site: Node, member: string) => { type: Node | null; parameter?: { name: string; at: Node } | undefined } | undefined) | undefined;
  readonly unwrapCalls?: readonly string[] | undefined;
  // `if let Some(x) = source`, `while let`, and a `Some(x) =>` match arm: `x` is what the source wraps.
  readonly unwrapPattern?: ((node: Node) => ReadonlyArray<{ name: Node; source: Node }>) | undefined;
  // What a collection type holds: the element type of a slice, array, list or set, or the value type of a map.
  readonly contents?: ((type: Node | null) => { element?: Node | null | undefined; value?: Node | null | undefined } | undefined) | undefined;
  // Index access (`xs[i]`, `m[k]`) and the operand it indexes.
  readonly subscript?: ((node: Node) => Node | null) | undefined;
  // Loop variables and what they range over; a declared type wins over the source's contents.
  readonly loop?: ((node: Node) => ReadonlyArray<{ name: Node; type: Node | null; source: Node | null; mode?: "value" | "either" | undefined }>) | undefined;
  // An untyped first parameter of a lambda passed to one of these methods takes the receiver's element.
  readonly lambdaParam?: ((lambda: Node) => Node | null) | undefined;
  readonly callbackMethods?: readonly string[] | undefined;
}

interface Import { readonly source: string; readonly name: string }
interface Contents { readonly element?: string | undefined; readonly value?: string | undefined }
interface Declaration { readonly at: number; readonly type: string | undefined; readonly owner?: ReceiverOwner | undefined; readonly importOf?: Import | undefined; readonly contents?: Contents | undefined; readonly inner?: string | undefined }
// Declarations keep their source position so a call sees the binding in force where it occurs,
// not the last one declared in the scope.
interface Scope { readonly parent: Scope | null; readonly names: Map<string, Declaration[]>; readonly fn: boolean; receiver?: { name: string; type: string } | undefined; className?: string | undefined; fields?: Map<string, { type: string | undefined; contents?: Contents | undefined }> | undefined; staticFn?: boolean | undefined }

export interface TypedBindings {
  at: (fn: Node | null, site: Node) => EdgeBinding | undefined;
  heritage: (classNode: Node) => SymbolBinding[];
  returns: (fn: Node) => ReturnBinding | undefined;
  returnTuple: (fn: Node) => (ReturnBinding | null)[] | undefined;
  memberKind: (fn: Node) => MemberKind | undefined;
  unwrapped: (fn: Node) => ReturnBinding | undefined;
  elements: (fn: Node) => ReturnBinding | undefined;
  values: (fn: Node) => ReturnBinding | undefined;
  fieldTypes: (members: readonly Node[]) => Record<string, SymbolBinding> | undefined;
  elementTypes: (members: readonly Node[]) => Record<string, SymbolBinding> | undefined;
  valueTypes: (members: readonly Node[]) => Record<string, SymbolBinding> | undefined;
}

export function collectTypedBindings(root: Node, spec: TypedSpec): TypedBindings {
  const module: Scope = { parent: null, names: new Map(), fn: false };
  const scopes = new Map<number, Scope>();
  const fnScopes: Scope[] = [];

  const nearestFunction = (scope: Scope): Scope => { let current = scope; while (!current.fn && current.parent !== null) current = current.parent; return current; };
  const bind = (scope: Scope, name: string, at: number, type: string | undefined, owner?: ReceiverOwner, importOf?: Import, contents?: Contents, inner?: string): void => {
    const list = scope.names.get(name) ?? [];
    list.push({ at, type, owner, importOf, contents, inner });
    scope.names.set(name, list);
  };
  const declared = (scope: Scope, name: string, at: number): Declaration | undefined => {
    const list = scope.names.get(name);
    if (list === undefined) return undefined;
    let best: Declaration | undefined;
    for (const item of list) if (item.at <= at && (best === undefined || item.at >= best.at)) best = item;
    return best;
  };
  const importOf = (name: string): Import | undefined => module.names.get(name)?.find((item) => item.importOf !== undefined)?.importOf;
  // A type name becomes a local binding, or an import binding when the name (Rust) or its package
  // qualifier (Go) was imported.
  // A type parameter of an enclosing declaration names no type the index can hold, unless it is bounded
  // by a trait or interface: a call on `t: T` where `T: Runner` is a call on `Runner`, which is what the
  // compiler dispatches through too. Marker bounds (`Clone`, `Cloneable`, `class`) name no methods.
  const MARKER_BOUNDS = new Set(["Clone", "Copy", "Send", "Sync", "Sized", "Unpin", "Debug", "Default", "PartialEq", "Eq", "Hash", "Ord", "PartialOrd", "Display", "Cloneable", "Serializable", "Comparable", "Object", "IEquatable", "IComparable", "ICloneable", "class", "struct", "notnull", "unmanaged", "any", "comparable"]);
  const boundName = (bounds: readonly Node[]): string | undefined => {
    for (const bound of bounds) {
      const name = spec.typeName(bound);
      if (name !== undefined && !MARKER_BOUNDS.has(name)) return name;
    }
    return undefined;
  };
  const typeParameterOf = (name: string, site: Node | undefined): { declared: boolean; bound?: string | undefined } => {
    for (let current: Node | null = site ?? null; current !== null; current = current.parent) {
      const parameters = childrenOf(current).find((child) => child.type === "type_parameters" || child.type === "type_parameter_list");
      // A list the parser recovered from an error is not a declaration (a primary constructor can parse this way).
      if (parameters === undefined || parameters.hasError) continue;
      for (const parameter of childrenOf(parameters)) {
        const typed = spec.typeBounds?.(parameter);
        const declared = typed !== undefined ? typed.name
          : parameter.type === "type_parameter" || parameter.type === "type_parameter_declaration" || parameter.type === "constrained_type_parameter" || parameter.type === "type_identifier" || parameter.type === "identifier"
            ? (parameter.childForFieldName("name") ?? parameter.childForFieldName("left") ?? (parameter.type === "type_identifier" || parameter.type === "identifier" ? parameter : childrenOf(parameter).find((child) => child.type === "type_identifier" || child.type === "identifier")))?.text
            : undefined;
        if (declared !== name) continue;
        const bounds = [...(typed?.bounds ?? []), ...(spec.whereBounds?.(current, name) ?? [])];
        return { declared: true, bound: boundName(bounds) };
      }
    }
    return { declared: false };
  };
  const contentsOfType = (type: Node | null, site: Node): Contents | undefined => {
    const found = spec.contents?.(type);
    if (found === undefined) return undefined;
    const element = knownType(spec.typeName(found.element ?? null), site);
    const value = knownType(spec.typeName(found.value ?? null), site);
    return element === undefined && value === undefined ? undefined : { element, value };
  };
  const knownType = (type: string | undefined, site: Node): string | undefined => {
    if (type === undefined) return undefined;
    const parameter = typeParameterOf(type, site);
    return parameter.declared ? parameter.bound : type;
  };
  // The type an `Option<T>` or `Result<T, E>` annotation wraps, when the spec knows the wrapper.
  const innerOfType = (type: Node | null, site: Node): string | undefined => {
    const inner = type === null ? null : spec.innerType?.(type) ?? null;
    return inner === null ? undefined : knownType(spec.typeName(inner), site);
  };
  const ownerForType = (type: string, site?: Node): ReceiverOwner | undefined => {
    if (site !== undefined) {
      const parameter = typeParameterOf(type, site);
      if (parameter.declared) return parameter.bound === undefined ? undefined : ownerForType(parameter.bound);
    }
    const dot = type.indexOf(".");
    if (dot >= 0) {
      const pkg = importOf(type.slice(0, dot));
      return pkg === undefined || pkg.name !== "*" ? undefined : { kind: "import", source: pkg.source, importedName: type.slice(dot + 1) };
    }
    const item = importOf(type);
    return item !== undefined && item.name !== "*" ? { kind: "import", source: item.source, importedName: item.name } : { kind: "local", name: type };
  };
  const pathOwner = (head: string): ReceiverOwner | undefined => {
    const item = importOf(head);
    if (item === undefined) return { kind: "local", name: head };
    return item.name === "*" ? undefined : { kind: "import", source: item.source, importedName: item.name };
  };
  // An unbound capitalised identifier used as a receiver names a type (static access) in Java and C#.
  const classLike = (name: string, scope: Scope, at: number): boolean => spec.classNodes !== undefined && /^[A-Z]/.test(name) && !scopeBinds(scope, name, at) && fieldOwner(scope, name) === undefined;
  // A local shadows a package or type name only from its declaration onward.
  const scopeBinds = (scope: Scope, name: string, at: number): boolean => {
    for (let current: Scope | null = scope; current !== null && current !== module; current = current.parent) if (declared(current, name, at) !== undefined || current.receiver?.name === name) return true;
    return false;
  };
  const calleeOwner = (value: Node, scope: Scope, index?: number): ReceiverOwner | undefined => {
    // `f()?` and `f().unwrap()` name the value inside the wrapper: the callee's unwrapped return type.
    if (value.type === "try_expression") {
      const inner = childrenOf(value).find((child) => child.isNamed);
      const owner = inner === undefined ? undefined : calleeOwner(inner, scope, index);
      return owner?.kind === "return" ? { ...owner, unwrapped: true } : undefined;
    }
    if (value.type !== "call_expression" && value.type !== "method_invocation" && value.type !== "invocation_expression") return undefined;
    const fn = value.type === "method_invocation" ? value : value.childForFieldName("function");
    if (fn === null) return undefined;
    const callee = spec.callee(fn);
    if (callee === undefined) return undefined;
    if (spec.unwrapCalls?.includes(callee.name) && callee.object !== null && callee.path === undefined) {
      const owner = calleeOwner(callee.object, scope, index);
      return owner?.kind === "return" ? { ...owner, unwrapped: true } : undefined;
    }
    if (callee.name === "get" && callee.object !== null && callee.path === undefined) {
      const known = pick(knownContentsOf(callee.object, scope), "either");
      if (known !== undefined) return ownerForType(known);
    }
    let of: Callee | undefined;
    const at = value.startIndex;
    const pkg = callee.object?.type === "identifier" && !scopeBinds(scope, callee.object.text, at) ? importOf(callee.object.text) : callee.path !== undefined ? importOf(callee.path) : undefined;
    if (pkg?.name === "*") of = { kind: "import", source: pkg.source, importedName: callee.name };
    else if (pkg !== undefined && callee.path !== undefined && /^[a-z_]/.test(callee.path)) of = { kind: "import", source: `${pkg.source}::${pkg.name}`, importedName: callee.name };
    else if (callee.object === null && callee.path === undefined) {
      // An unqualified call inside a class body is a call on this (or the class) in Java and C#.
      const cls = classOf(scope);
      of = cls?.className !== undefined && spec.classNodes !== undefined && !scopeBinds(scope, callee.name, at)
        ? { kind: "method", owner: { kind: "local", name: cls.className }, member: callee.name }
        : { kind: "local", name: callee.name };
    }
    else if (callee.object?.type === "identifier" && classLike(callee.object.text, scope, at)) { const owner = ownerForType(callee.object.text); if (owner === undefined) return undefined; of = { kind: "method", owner, member: callee.name, mode: "class" }; }
    else if (callee.path !== undefined) { const owner = pathOwner(callee.path); if (owner === undefined) return undefined; of = { kind: "method", owner, member: callee.name, mode: "class" }; }
    else {
      if (callee.object === null) return undefined;
      const receiver = receiverOf(callee.object, scope);
      if (receiver === undefined) return undefined;
      of = { kind: "method", owner: receiver, member: callee.name, mode: "instance" };
    }
    return bounded(index === undefined ? { kind: "return", of } : { kind: "return", of, index });
  };
  const classOf = (scope: Scope): Scope | undefined => { for (let current: Scope | null = scope; current !== null; current = current.parent) if (current.className !== undefined) return current; return undefined; };
  const fieldOwner = (scope: Scope, name: string): ReceiverOwner | undefined => {
    const cls = classOf(scope);
    if (cls === undefined || cls.fields === undefined || !cls.fields.has(name)) return undefined;
    const type = cls.fields.get(name)?.type;
    return type === undefined ? undefined : ownerForType(type);
  };
  const fieldContents = (scope: Scope, name: string): Contents | undefined => classOf(scope)?.fields?.get(name)?.contents;
  const pick = (contents: Contents | undefined, mode: "value" | "either" | undefined): string | undefined =>
    contents === undefined ? undefined : mode === "value" ? contents.value : mode === "either" ? contents.value ?? contents.element : contents.element;
  // Owner nesting is capped so the cache validator (limit sixteen) always accepts what extraction stores.
  const ownerDepth = (owner: ReceiverOwner | Callee): number =>
    owner.kind === "return" ? 1 + ownerDepth(owner.of) : owner.kind === "method" ? 1 + ownerDepth(owner.owner) : owner.kind === "field" || owner.kind === "element" ? 1 + ownerDepth(owner.of) : 0;
  const bounded = (owner: ReceiverOwner | undefined): ReceiverOwner | undefined => owner !== undefined && ownerDepth(owner) > 12 ? undefined : owner;
  const STRIP = new Set(["parenthesized_expression", "reference_expression", "unary_expression"]);
  const strip = (node: Node): Node => { let current = node; while (STRIP.has(current.type)) { const inner = childrenOf(current).find((child) => child.isNamed); if (inner === undefined) break; current = inner; } return current; };
  const PASS_THROUGH = new Set(["iter", "iter_mut", "into_iter", "cloned", "copied", "stream", "values", "sorted", "distinct", "Where", "OrderBy", "OrderByDescending", "Distinct", "ToList", "ToArray", "AsEnumerable", "Skip", "Take", "Reverse"]);
  // The contents recorded for a collection expression in this file: a binding, a field of this, or a
  // pass-through call (`xs.iter()`, `list.stream()`) on one of those.
  const knownContentsOf = (object: Node, scope: Scope): Contents | undefined => {
    object = strip(object);
    if (object.type === "identifier") {
      for (let current: Scope | null = scope; current !== null; current = current.parent) { const found = declared(current, object.text, object.startIndex); if (found !== undefined) return found.contents; }
      return fieldContents(scope, object.text);
    }
    if (["field_access", "member_access_expression", "selector_expression", "field_expression"].includes(object.type)) {
      const inner = object.childForFieldName("object") ?? object.childForFieldName("expression") ?? object.childForFieldName("operand") ?? object.childForFieldName("value");
      const field = object.childForFieldName("field") ?? object.childForFieldName("name");
      return inner !== null && field !== null && spec.thisNodes?.includes(inner.type) ? fieldContents(scope, field.text) : undefined;
    }
    if (object.type === "call_expression" || object.type === "method_invocation" || object.type === "invocation_expression") {
      const fn = object.type === "method_invocation" ? object : object.childForFieldName("function");
      const callee = fn === null ? undefined : spec.callee(fn);
      return callee?.object !== null && callee?.object !== undefined && callee.path === undefined && PASS_THROUGH.has(callee.name) ? knownContentsOf(callee.object, scope) : undefined;
    }
    return undefined;
  };
  // The element (or value) of a collection expression: a binding with recorded contents, or an element owner
  // over the receiver so resolution can consult the holder's tables.
  const elementOf = (object: Node, scope: Scope, mode?: "value" | "either"): ReceiverOwner | undefined => {
    object = strip(object);
    const name = pick(knownContentsOf(object, scope), mode);
    if (name !== undefined) return ownerForType(name);
    const base = receiverOf(object, scope);
    return base === undefined ? undefined : bounded({ kind: "element", of: base, ...(mode === undefined ? {} : { mode }) });
  };
  const receiverOf = (object: Node, scope: Scope): ReceiverOwner | undefined => {
    const at = object.startIndex;
    if (object.type === "call_expression" || object.type === "method_invocation" || object.type === "invocation_expression" || object.type === "try_expression") return calleeOwner(object, scope);
    if (object.type === "parenthesized_expression") { const inner = childrenOf(object)[0]; return inner === undefined ? undefined : receiverOf(inner, scope); }
    const indexed = spec.subscript?.(object);
    if (indexed !== undefined && indexed !== null) return elementOf(indexed, scope, "either");
    if (spec.thisNodes?.includes(object.type)) {
      const cls = classOf(scope);
      return cls?.className === undefined || nearestFunction(scope).staticFn === true ? undefined : { kind: "local", name: cls.className };
    }
    if (object.type === "super" || object.type === "base_expression") {
      const cls = classOf(scope);
      return cls?.className === undefined ? undefined : { kind: "super", of: { kind: "local", name: cls.className } };
    }
    if (["field_access", "member_access_expression", "selector_expression", "field_expression"].includes(object.type)) {
      const inner = object.childForFieldName("object") ?? object.childForFieldName("expression") ?? object.childForFieldName("operand") ?? object.childForFieldName("value");
      const field = object.childForFieldName("field") ?? object.childForFieldName("name");
      if (inner === null || field === null || (field.type !== "identifier" && field.type !== "field_identifier")) return undefined;
      if (spec.thisNodes?.includes(inner.type)) { const own = fieldOwner(scope, field.text); if (own !== undefined) return own; }
      // Only a field whose declared type is a struct parameter takes this path (the impl's argument and its
      // bounds); a plain field stays a field owner so resolution consults the holder's element and value tables.
      if (inner.type === "self" && spec.implField !== undefined) {
        const found = spec.implField(object, field.text);
        const name = found?.parameter === undefined ? undefined : knownType(found.parameter.name, found.parameter.at);
        if (name !== undefined) return ownerForType(name);
      }
      // A field of a bound receiver: the holder's declared field type is looked up at resolution time.
      const base = receiverOf(inner, scope);
      return base === undefined ? undefined : bounded({ kind: "field", of: base, member: field.text });
    }
    if (object.type !== "identifier" && object.type !== "self") return undefined;
    // Walk outward: a closure inside a method still sees the method's receiver (`self`, `s`), and a
    // closer binding of the same name shadows it.
    for (let current: Scope | null = scope; current !== null; current = current.parent) {
      if (current.receiver !== undefined && (object.type === "self" || current.receiver.name === object.text)) return ownerForType(current.receiver.type);
      if (object.type === "self") continue;
      const found = declared(current, object.text, at);
      if (found === undefined) continue;
      if (found.owner !== undefined) return found.owner;
      if (found.importOf !== undefined) return undefined;
      return found.type === undefined ? undefined : ownerForType(found.type);
    }
    return object.type === "self" ? undefined : fieldOwner(scope, object.text);
  };

  const visit = (node: Node, outer: Scope): void => {
    let scope = outer;
    if (spec.classNodes?.includes(node.type)) {
      const fields = new Map<string, { type: string | undefined; contents?: Contents | undefined }>();
      for (const member of childrenOf(node.childForFieldName("body") ?? node)) for (const field of spec.field?.(member) ?? []) if (!field.isStatic) fields.set(field.name, { type: spec.typeName(field.type), contents: contentsOfType(field.type, member) });
      scope = { parent: outer, names: new Map(), fn: false, className: node.childForFieldName("name")?.text, fields };
    } else if (spec.functionNodes.includes(node.type)) {
      scope = { parent: outer, names: new Map(), fn: true, receiver: spec.receiver(node), staticFn: spec.isStatic?.(node) ?? false };
      fnScopes.push(scope);
      for (const child of childrenOf(node)) {
        const parameter = spec.parameter(child);
        if (parameter !== undefined) bind(scope, parameter.name.text, node.startIndex, knownType(spec.typeName(parameter.type), node), undefined, undefined, contentsOfType(parameter.type, node), innerOfType(parameter.type, node));
        for (const nested of childrenOf(child)) {
          const inner = spec.parameter(nested);
          if (inner !== undefined) bind(scope, inner.name.text, node.startIndex, knownType(spec.typeName(inner.type), node), undefined, undefined, contentsOfType(inner.type, node), innerOfType(inner.type, node));
        }
      }
      // `xs.forEach(x -> ..)`: an untyped first lambda parameter takes the element of the receiver.
      const lambdaName = spec.lambdaParam?.(node);
      let argumentsNode = node.parent;
      if (argumentsNode?.type === "argument") argumentsNode = argumentsNode.parent;
      const call = argumentsNode?.parent;
      const callee = call === null || call === undefined ? undefined : spec.callee(call.type === "method_invocation" ? call : call.childForFieldName("function") ?? call);
      const firstArgument = argumentsNode === null || argumentsNode === undefined ? undefined : childrenOf(argumentsNode).find((child) => child.isNamed);
      const firstIs = firstArgument !== undefined && (firstArgument.id === node.id || (firstArgument.type === "argument" && childrenOf(firstArgument).some((child) => child.id === node.id)));
      if (lambdaName !== null && lambdaName !== undefined && firstIs && callee?.object !== null && callee?.object !== undefined && callee.path === undefined && spec.callbackMethods?.includes(callee.name)) {
        const owner = elementOf(callee.object, outer);
        if (owner !== undefined) bind(scope, lambdaName.text, node.startIndex, undefined, owner);
      }
    } else if (spec.scopeNodes.includes(node.type)) {
      scope = { parent: outer, names: new Map(), fn: false };
    }
    scopes.set(node.id, scope);
    // An import inside an inline module (Rust `mod tests { use super::X; }`) binds there, so it never
    // shadows the file's own import or definition of that name.
    for (const item of spec.imports(node)) bind(scope, item.local, scope === module ? -1 : node.startIndex, undefined, undefined, { source: item.source, name: item.name });
    for (const local of spec.local(node)) {
      const declaredType = knownType(spec.typeName(local.type), node);
      const constructed = declaredType ?? spec.constructed(local.value);
      const produced = constructed === undefined && local.value !== null ? calleeOwner(local.value, scope, local.index) : undefined;
      const indexed = constructed === undefined && produced === undefined && local.value !== null ? spec.subscript?.(strip(local.value)) : undefined;
      bind(scope, local.name.text, node.startIndex, constructed, produced ?? (indexed === undefined || indexed === null ? undefined : elementOf(indexed, scope, "either")), undefined, contentsOfType(local.type, node), innerOfType(local.type, node));
    }
    for (const item of spec.unwrapPattern?.(node) ?? []) {
      const source = strip(item.source);
      if (source.type === "identifier") {
        for (let current: Scope | null = scope; current !== null; current = current.parent) {
          const found = declared(current, source.text, source.startIndex);
          if (found === undefined) continue;
          if (found.inner !== undefined) bind(scope, item.name.text, node.startIndex, found.inner);
          break;
        }
      } else {
        const owner = calleeOwner(source, scope);
        if (owner?.kind === "return") bind(scope, item.name.text, node.startIndex, undefined, { ...owner, unwrapped: true });
      }
    }
    for (const item of spec.loop?.(node) ?? []) {
      const declaredType = knownType(spec.typeName(item.type), node);
      if (declaredType !== undefined) bind(scope, item.name.text, node.startIndex, declaredType, undefined, undefined, contentsOfType(item.type, node));
      else if (item.source !== null) { const owner = elementOf(item.source, scope, item.mode); if (owner !== undefined) bind(scope, item.name.text, node.startIndex, undefined, owner); }
    }
    for (const child of childrenOf(node)) visit(child, scope);
  };
  visit(root, module);

  const contentTable = (members: readonly Node[], which: "element" | "value"): Record<string, SymbolBinding> | undefined => {
    const out: Record<string, SymbolBinding> = {};
    for (const member of members) for (const field of spec.field?.(member) ?? []) {
      if (field.isStatic) continue;
      const type = contentsOfType(field.type, member)?.[which];
      const owner = type === undefined ? undefined : asReturn(ownerForType(type, member));
      if (owner !== undefined) out[field.name] = owner;
    }
    return Object.keys(out).length === 0 ? undefined : out;
  };
  return {
    at(fn, site) {
      if (fn === null) return undefined;
      const callee = spec.callee(fn);
      if (callee === undefined) return undefined;
      if (callee.path !== undefined) {
        const pkg = importOf(callee.path);
        if (pkg?.name === "*") return { kind: "import", source: pkg.source, importedName: callee.name };
        if (pkg !== undefined && /^[a-z_]/.test(callee.path)) return { kind: "import", source: `${pkg.source}::${pkg.name}`, importedName: callee.name };
        const owner = pathOwner(callee.path);
        return owner === undefined ? { kind: "blocked", reason: "unknown-receiver" } : { kind: "member", owner, member: callee.name, mode: "class", basis: "class-reference" };
      }
      if (callee.object === null) return undefined;
      const scope = scopes.get(site.id) ?? module;
      if (callee.object.type === "identifier") {
        const pkg = importOf(callee.object.text);
        if (pkg?.name === "*" && receiverOf(callee.object, scope) === undefined && !scopeBinds(scope, callee.object.text, callee.object.startIndex)) return { kind: "import", source: pkg.source, importedName: callee.name };
        if (classLike(callee.object.text, scope, callee.object.startIndex)) { const owner = ownerForType(callee.object.text); return owner === undefined ? { kind: "blocked", reason: "unknown-receiver" } : { kind: "member", owner, member: callee.name, mode: "class", basis: "class-reference" }; }
      }
      const owner = receiverOf(callee.object, scope);
      if (owner === undefined) return { kind: "blocked", reason: "unknown-receiver" };
      const basis = owner.kind === "return" ? "return" : callee.object.type === "self" || spec.thisNodes?.includes(callee.object.type) || nearestFunction(scope).receiver?.name === callee.object.text ? "lexical" : "annotation";
      return { kind: "member", owner, member: callee.name, mode: "instance", basis };
    },
    returns(fn) {
      const type = spec.returnType(fn);
      if (type === null) return undefined;
      if (type.type === "type_identifier" && type.text === "Self") return spec.memberKind(fn) === undefined ? undefined : { kind: "this" };
      const name = spec.typeName(type);
      if (name === undefined) return undefined;
      const owner = ownerForType(name, fn);
      return asReturn(owner);
    },
    returnTuple(fn) {
      const types = spec.returnTypes?.(fn);
      if (types === undefined || types.length < 2) return undefined;
      return types.map((type) => { const name = spec.typeName(type); const owner = name === undefined ? undefined : ownerForType(name, fn); return asReturn(owner) ?? null; });
    },
    memberKind: (fn) => spec.memberKind(fn),
    unwrapped(fn) {
      const type = spec.returnType(fn);
      const inner = type === null ? null : spec.innerType?.(type) ?? null;
      if (inner === null) return undefined;
      if (inner.type === "type_identifier" && inner.text === "Self") return spec.memberKind(fn) === undefined ? undefined : { kind: "this" };
      const name = spec.typeName(inner);
      const owner = name === undefined ? undefined : ownerForType(name, fn);
      return asReturn(owner);
    },
    elements(fn) { const name = spec.contents?.(spec.returnType(fn))?.element; const type = knownType(spec.typeName(name ?? null), fn); return type === undefined ? undefined : asReturn(ownerForType(type, fn)); },
    values(fn) { const name = spec.contents?.(spec.returnType(fn))?.value; const type = knownType(spec.typeName(name ?? null), fn); return type === undefined ? undefined : asReturn(ownerForType(type, fn)); },
    elementTypes: (members) => contentTable(members, "element"),
    valueTypes: (members) => contentTable(members, "value"),
    fieldTypes: (members) => {
      const out: Record<string, SymbolBinding> = {};
      for (const member of members) for (const field of spec.field?.(member) ?? []) {
        if (field.isStatic) continue;
        const name = spec.typeName(field.type);
        const owner = name === undefined ? undefined : ownerForType(name, member);
        if (owner !== undefined && (owner.kind === "local" || owner.kind === "import")) out[field.name] = owner;
      }
      return Object.keys(out).length === 0 ? undefined : out;
    },
    heritage: (classNode) => {
      const out: SymbolBinding[] = [];
      for (const base of spec.bases?.(classNode) ?? []) {
        const owner = ownerForType(base);
        if (owner !== undefined && (owner.kind === "local" || owner.kind === "import")) out.push(owner);
      }
      return out;
    },
  };
}

// The base name of a type: wrappers such as pointers and references are stripped, and a generic
// instantiation names its base (Vec<T> is a Vec, Wrapper<Foo> is a Wrapper).
const asReturn = (owner: ReceiverOwner | undefined): SymbolBinding | undefined => owner !== undefined && (owner.kind === "local" || owner.kind === "import") ? owner : undefined;

const simpleType = (node: Node | null, wrappers: readonly string[]): string | undefined => {
  let current = node;
  while (current !== null && wrappers.includes(current.type)) current = current.childForFieldName("type") ?? childrenOf(current).find((child) => child.type !== "mutable_specifier" && child.type !== "lifetime") ?? null;
  if (current?.type === "generic_type") current = current.childForFieldName("type") ?? childrenOf(current)[0] ?? null;
  return current?.type === "type_identifier" ? current.text : undefined;
};

export const goSpec: TypedSpec = {
  functionNodes: ["function_declaration", "method_declaration", "func_literal"],
  typeBounds: (parameter) => {
    if (parameter.type !== "type_parameter_declaration" && parameter.type !== "parameter_declaration") return undefined;
    const name = parameter.childForFieldName("name")?.text;
    const type = parameter.childForFieldName("type");
    return name === undefined ? undefined : { name, bounds: type !== null && (type.type === "type_identifier" || type.type === "qualified_type") ? [type] : [] };
  },
  scopeNodes: ["block", "if_statement", "for_statement"],
  contents: (type) => {
    let current = type;
    while (current !== null && (current.type === "pointer_type" || current.type === "parenthesized_type")) current = current.childForFieldName("type") ?? childrenOf(current)[0] ?? null;
    if (current === null) return undefined;
    if (current.type === "slice_type" || current.type === "array_type") return { element: current.childForFieldName("element") };
    if (current.type === "map_type") return { value: current.childForFieldName("value") };
    return undefined;
  },
  subscript: (node) => node.type === "index_expression" ? node.childForFieldName("operand") : null,
  loop: (node) => {
    if (node.type !== "for_statement") return [];
    const range = childrenOf(node).find((child) => child.type === "range_clause");
    if (range === undefined) return [];
    const names = childrenOf(range.childForFieldName("left") ?? range).filter((child) => child.type === "identifier");
    const source = range.childForFieldName("right");
    const second = names[1];
    return second === undefined ? [] : [{ name: second, type: null, source, mode: "either" }];
  },
  field: (node) => {
    if (node.type !== "field_declaration") return [];
    const type = node.childForFieldName("type");
    return childrenOf(node).filter((child) => child.type === "field_identifier").map((name) => ({ name: name.text, type, isStatic: false }));
  },
  parameter: (node) => {
    if (node.type !== "parameter_declaration") return undefined;
    const name = node.childForFieldName("name");
    return name?.type === "identifier" ? { name, type: node.childForFieldName("type") } : undefined;
  },
  typeName: (node) => {
    let current = node;
    while (current !== null && ["pointer_type", "parenthesized_type"].includes(current.type)) current = current.childForFieldName("type") ?? childrenOf(current)[0] ?? null;
    if (current?.type === "qualified_type") return current.text;
    return simpleType(current, ["generic_type"]);
  },
  returnType: (fn) => { const result = fn.childForFieldName("result"); return result === null || result.type === "parameter_list" ? null : result; },
  returnTypes: (fn) => {
    const result = fn.childForFieldName("result");
    if (result === null || result.type !== "parameter_list") return undefined;
    // A named or unnamed result list: one type per declaration, a declaration with several names repeats its type.
    const types: (Node | null)[] = [];
    for (const declaration of childrenOf(result)) {
      if (declaration.type !== "parameter_declaration") continue;
      const type = declaration.childForFieldName("type") ?? childrenOf(declaration).at(-1) ?? null;
      const names = childrenOf(declaration).filter((child) => child.type === "identifier").length;
      for (let i = 0; i < Math.max(1, names); i += 1) types.push(type);
    }
    return types;
  },
  receiver: (fn) => {
    if (fn.type !== "method_declaration") return undefined;
    const declaration = childrenOf(fn.childForFieldName("receiver") ?? fn).find((child) => child.type === "parameter_declaration");
    const name = declaration?.childForFieldName("name");
    const type = simpleType(declaration?.childForFieldName("type") ?? null, ["pointer_type", "generic_type"]);
    return name !== null && name !== undefined && type !== undefined ? { name: name.text, type } : undefined;
  },
  memberKind: (fn) => fn.type === "method_declaration" ? "instance" : undefined,
  local: (node) => {
    if (node.type === "short_var_declaration") {
      const names = childrenOf(node.childForFieldName("left") ?? node).filter((child) => child.type === "identifier");
      const values = childrenOf(node.childForFieldName("right") ?? node);
      if (names.length === 1 && values.length === 1 && names[0] !== undefined) return [{ name: names[0], type: null, value: values[0] ?? null }];
      // a, b := f() takes each name from the matching position of f's result list.
      if (names.length > 1 && values.length === 1 && values[0]?.type === "call_expression") return names.map((name, index) => ({ name, type: null, value: values[0] ?? null, index }));
      return names.map((name, index) => ({ name, type: null, value: names.length === values.length ? values[index] ?? null : null }));
    }
    if (node.type === "var_spec") {
      const names = childrenOf(node).filter((child) => child.type === "identifier");
      const values = childrenOf(node.childForFieldName("value") ?? node);
      return names.map((name, index) => ({ name, type: node.childForFieldName("type"), value: names.length === values.length ? values[index] ?? null : null }));
    }
    return [];
  },
  constructed: (value) => {
    // `new(T)` and `&T{}` construct a T, keeping the package qualifier so a `pkg.T` binds through the import.
    if (value?.type === "call_expression" && value.childForFieldName("function")?.text === "new") {
      const argument = childrenOf(value.childForFieldName("arguments") ?? value).find((child) => child.isNamed);
      return argument === undefined ? undefined : goSpec.typeName(argument);
    }
    const literal = value?.type === "unary_expression" ? value.childForFieldName("operand") : value;
    return literal?.type === "composite_literal" ? goSpec.typeName(literal.childForFieldName("type")) : undefined;
  },
  callee: (fn) => {
    if (fn.type === "identifier") return { object: null, name: fn.text };
    if (fn.type !== "selector_expression") return undefined;
    const object = fn.childForFieldName("operand");
    const field = fn.childForFieldName("field");
    return object !== null && field !== null ? { object, name: field.text } : undefined;
  },
  imports: (node) => {
    if (node.type !== "import_spec") return [];
    const source = node.childForFieldName("path")?.text.replace(/^["'`]|["'`]$/g, "");
    if (source === undefined) return [];
    const alias = node.childForFieldName("name")?.text;
    const local = alias ?? source.split("/").pop() ?? source;
    return alias === "_" || alias === "." ? [] : [{ local, source, name: "*" }];
  },
};

export const rustSpec: TypedSpec = {
  functionNodes: ["function_item", "closure_expression"],
  contents: (type) => {
    let current = type;
    while (current !== null && current.type === "reference_type") current = current.childForFieldName("type") ?? childrenOf(current).find((child) => child.isNamed && child.type !== "mutable_specifier" && child.type !== "lifetime") ?? null;
    if (current === null) return undefined;
    if (current.type === "slice_type" || current.type === "array_type") return { element: current.childForFieldName("element") ?? childrenOf(current).find((child) => child.isNamed) ?? null };
    if (current.type !== "generic_type") return undefined;
    const base = current.childForFieldName("type") ?? childrenOf(current)[0];
    const name = base === undefined ? undefined : base.type === "type_identifier" ? base.text : base.type === "scoped_type_identifier" ? base.childForFieldName("name")?.text : undefined;
    const arguments_ = childrenOf(childrenOf(current).find((child) => child.type === "type_arguments") ?? current).filter((child) => child.isNamed);
    if (name !== undefined && ["Vec", "VecDeque", "HashSet", "BTreeSet", "LinkedList", "BinaryHeap"].includes(name)) return { element: arguments_[0] ?? null };
    if (name !== undefined && ["HashMap", "BTreeMap"].includes(name)) return { value: arguments_[1] ?? null };
    return undefined;
  },
  subscript: (node) => node.type === "index_expression" ? childrenOf(node).find((child) => child.isNamed) ?? null : null,
  loop: (node) => {
    if (node.type !== "for_expression") return [];
    const pattern = node.childForFieldName("pattern");
    return pattern?.type === "identifier" ? [{ name: pattern, type: null, source: node.childForFieldName("value") }] : [];
  },
  lambdaParam: (lambda) => { const parameters = lambda.childForFieldName("parameters"); const first = parameters === null ? undefined : childrenOf(parameters).find((child) => child.isNamed); return first?.type === "identifier" ? first : null; },
  callbackMethods: ["map", "filter", "for_each", "any", "all", "find", "filter_map", "flat_map", "position", "take_while", "skip_while", "inspect", "max_by_key", "min_by_key", "sort_by_key", "retain", "partition", "find_map"],
  unwrapCalls: ["unwrap", "expect", "unwrap_or_default", "unwrap_unchecked"],
  typeBounds: (parameter) => {
    if (parameter.type === "constrained_type_parameter") {
      const name = parameter.childForFieldName("left")?.text;
      return name === undefined ? undefined : { name, bounds: childrenOf(parameter.childForFieldName("bounds") ?? parameter).filter((child) => child.type !== "lifetime" && child.isNamed) };
    }
    return parameter.type === "type_identifier" ? { name: parameter.text, bounds: [] } : undefined;
  },
  implField: (site, member) => {
    let impl: Node | null = site;
    while (impl !== null && impl.type !== "impl_item") impl = impl.parent;
    if (impl === null) return undefined;
    let implType = impl.childForFieldName("type");
    const args: Node[] = [];
    if (implType?.type === "generic_type") { for (const child of childrenOf(childrenOf(implType).find((c) => c.type === "type_arguments") ?? implType)) if (child.isNamed && child.type !== "lifetime") args.push(child); implType = implType.childForFieldName("type"); }
    if (implType?.type !== "type_identifier") return undefined;
    const structName = implType.text;
    const declarations = (node: Node): Node[] => childrenOf(node).flatMap((child) => child.type === "mod_item" ? declarations(child.childForFieldName("body") ?? child) : [child]);
    const struct = declarations(site.tree.rootNode).find((node) => node.type === "struct_item" && node.childForFieldName("name")?.text === structName);
    if (struct === undefined) return undefined;
    const fieldNode = childrenOf(struct.childForFieldName("body") ?? struct).find((child) => child.type === "field_declaration" && child.childForFieldName("name")?.text === member);
    if (fieldNode === undefined) return undefined;
    const type = fieldNode.childForFieldName("type");
    const parameters = childrenOf(childrenOf(struct).find((child) => child.type === "type_parameters") ?? struct).filter((child) => child.isNamed && child.type !== "lifetime").map((child) => child.type === "constrained_type_parameter" ? child.childForFieldName("left")?.text : child.text);
    const index = type?.type === "type_identifier" ? parameters.indexOf(type.text) : -1;
    const argument = index >= 0 ? args[index] : undefined;
    return argument?.type === "type_identifier" ? { type, parameter: { name: argument.text, at: impl } } : { type };
  },
  whereBounds: (declaration, name) => {
    const clause = childrenOf(declaration).find((child) => child.type === "where_clause");
    if (clause === undefined) return [];
    return childrenOf(clause).filter((predicate) => predicate.type === "where_predicate" && predicate.childForFieldName("left")?.text === name)
      .flatMap((predicate) => childrenOf(predicate.childForFieldName("bounds") ?? predicate).filter((child) => child.type !== "lifetime" && child.isNamed));
  },
  unwrapPattern: (node) => {
    const unwrapped = (pattern: Node | null, source: Node | null): ReadonlyArray<{ name: Node; source: Node }> => {
      if (pattern?.type === "match_pattern") pattern = childrenOf(pattern).find((child) => child.isNamed) ?? null;
      if (pattern?.type !== "tuple_struct_pattern" || source === null) return [];
      const wrapper = pattern.childForFieldName("type")?.text;
      const inner = childrenOf(pattern).filter((child) => child.isNamed && child.id !== pattern!.childForFieldName("type")?.id);
      return (wrapper === "Some" || wrapper === "Ok") && inner.length === 1 && inner[0]!.type === "identifier" ? [{ name: inner[0]!, source }] : [];
    };
    if (node.type === "if_expression" || node.type === "while_expression") {
      const condition = node.childForFieldName("condition");
      return condition?.type === "let_condition" ? unwrapped(condition.childForFieldName("pattern"), condition.childForFieldName("value")) : [];
    }
    if (node.type === "match_arm") {
      const match = node.parent?.parent;
      return match?.type === "match_expression" ? unwrapped(node.childForFieldName("pattern"), match.childForFieldName("value")) : [];
    }
    return [];
  },
  innerType: (type) => {
    if (type.type !== "generic_type") return null;
    const base = type.childForFieldName("type") ?? childrenOf(type)[0];
    const name = base === undefined ? undefined : base.type === "type_identifier" ? base.text : base.type === "scoped_type_identifier" ? base.childForFieldName("name")?.text : undefined;
    if (name !== "Result" && name !== "Option") return null;
    const arguments_ = childrenOf(type).find((child) => child.type === "type_arguments");
    return arguments_ === undefined ? null : childrenOf(arguments_).find((child) => child.isNamed) ?? null;
  },
  field: (node) => {
    if (node.type !== "field_declaration") return [];
    const name = node.childForFieldName("name")?.text;
    return name === undefined ? [] : [{ name, type: node.childForFieldName("type"), isStatic: false }];
  },
  scopeNodes: ["block", "match_arm", "if_expression", "for_expression", "while_expression", "loop_expression", "mod_item"],
  parameter: (node) => {
    if (node.type !== "parameter") return undefined;
    const name = node.childForFieldName("pattern");
    return name?.type === "identifier" ? { name, type: node.childForFieldName("type") } : undefined;
  },
  // References, smart pointers and `dyn Trait` name the pointee: a call auto-derefs to it.
  typeName: (node) => {
    let current = node;
    for (;;) {
      if (current === null) return undefined;
      if (current.type === "reference_type" || current.type === "dynamic_type" || current.type === "abstract_type") { current = current.childForFieldName("type") ?? current.childForFieldName("trait") ?? childrenOf(current).find((child) => child.isNamed && child.type !== "mutable_specifier" && child.type !== "lifetime") ?? null; continue; }
      if (current.type === "generic_type") {
        const base = current.childForFieldName("type") ?? childrenOf(current)[0];
        if (base !== undefined && base.type === "type_identifier" && ["Box", "Rc", "Arc"].includes(base.text)) { current = childrenOf(childrenOf(current).find((child) => child.type === "type_arguments") ?? current).find((child) => child.isNamed) ?? null; continue; }
      }
      break;
    }
    return current.type === "primitive_type" ? current.text : simpleType(current, []);
  },
  returnType: (fn) => fn.childForFieldName("return_type"),
  receiver: (fn) => {
    if (fn.type !== "function_item" || !childrenOf(fn.childForFieldName("parameters") ?? fn).some((child) => child.type === "self_parameter")) return undefined;
    let current: Node | null = fn.parent;
    while (current !== null && current.type !== "impl_item") current = current.parent;
    const type = current === null ? undefined : simpleType(current.childForFieldName("type"), ["generic_type", "reference_type"]);
    return type === undefined ? undefined : { name: "self", type };
  },
  memberKind: (fn) => {
    if (fn.type !== "function_item" && fn.type !== "function_signature_item") return undefined;
    let current: Node | null = fn.parent;
    while (current !== null && current.type !== "impl_item" && current.type !== "trait_item") current = current.parent;
    if (current === null) return undefined;
    return childrenOf(fn.childForFieldName("parameters") ?? fn).some((child) => child.type === "self_parameter") ? "instance" : "static";
  },
  local: (node) => {
    if (node.type !== "let_declaration") return [];
    const name = node.childForFieldName("pattern");
    return name?.type === "identifier" ? [{ name, type: node.childForFieldName("type"), value: node.childForFieldName("value") }] : [];
  },
  constructed: (value) => value?.type === "struct_expression" ? simpleType(value.childForFieldName("name"), []) : undefined,
  callee: (fn) => {
    if (fn.type === "identifier") return { object: null, name: fn.text };
    if (fn.type === "generic_function") { const inner = fn.childForFieldName("function"); return inner === null ? undefined : rustSpec.callee(inner); }
    if (fn.type === "scoped_identifier") {
      const path = fn.childForFieldName("path");
      const name = fn.childForFieldName("name");
      if (name === null || path === null) return undefined;
      const head = path.type === "identifier" ? path.text : undefined;
      return head === undefined ? undefined : { object: null, name: name.text, path: head };
    }
    if (fn.type !== "field_expression") return undefined;
    const object = fn.childForFieldName("value");
    const field = fn.childForFieldName("field");
    return object !== null && field !== null ? { object, name: field.text } : undefined;
  },
  imports: (node) => {
    if (node.type !== "use_declaration") return [];
    const argument = node.childForFieldName("argument") ?? childrenOf(node).find((child) => child.type !== "visibility_modifier");
    if (argument === undefined || argument === null) return [];
    const out: Array<{ local: string; source: string; name: string }> = [];
    const item = (source: string, entry: Node): void => {
      if (entry.type === "identifier") out.push({ local: entry.text, source, name: entry.text });
      else if (entry.type === "use_as_clause") { const path = entry.childForFieldName("path"); const alias = entry.childForFieldName("alias"); if (path !== null && alias !== null) { const segments = path.text.split("::"); out.push({ local: alias.text, source: [source, ...segments.slice(0, -1)].filter((part) => part.length > 0).join("::"), name: segments[segments.length - 1] ?? path.text }); } }
      else if (entry.type === "scoped_identifier") { const name = entry.childForFieldName("name")?.text; const path = entry.childForFieldName("path")?.text; if (name !== undefined) out.push({ local: name, source: [source, path].filter((part) => part !== undefined && part.length > 0).join("::"), name }); }
      else if (entry.type === "scoped_use_list") { const path = entry.childForFieldName("path")?.text; for (const child of childrenOf(entry.childForFieldName("list") ?? entry)) item([source, path].filter((part) => part !== undefined && part.length > 0).join("::"), child); }
    };
    if (argument.type === "scoped_identifier" || argument.type === "scoped_use_list" || argument.type === "use_as_clause" || argument.type === "identifier") item("", argument);
    else if (argument.type === "use_list") for (const child of childrenOf(argument)) item("", child);
    return out;
  },
};

const modifiersStatic = (node: Node): boolean => childrenOf(node).some((child) => (child.type === "modifiers" && /\bstatic\b/.test(child.text)) || (child.type === "modifier" && child.text === "static"));

export const javaSpec: TypedSpec = {
  functionNodes: ["method_declaration", "constructor_declaration", "lambda_expression"],
  contents: (type) => {
    if (type === null) return undefined;
    if (type.type === "array_type") return { element: type.childForFieldName("element") };
    if (type.type !== "generic_type") return undefined;
    const base = childrenOf(type).find((child) => child.type === "type_identifier" || child.type === "scoped_type_identifier");
    const name = base?.type === "scoped_type_identifier" ? base.childForFieldName("name")?.text : base?.text;
    const arguments_ = childrenOf(childrenOf(type).find((child) => child.type === "type_arguments") ?? type).filter((child) => child.isNamed);
    if (name !== undefined && ["List", "ArrayList", "LinkedList", "Collection", "Iterable", "Iterator", "Set", "HashSet", "LinkedHashSet", "TreeSet", "SortedSet", "Deque", "ArrayDeque", "Queue", "Stream", "Optional"].includes(name)) return { element: arguments_[0] ?? null };
    if (name !== undefined && ["Map", "HashMap", "LinkedHashMap", "TreeMap", "SortedMap", "ConcurrentHashMap", "ConcurrentMap"].includes(name)) return { value: arguments_[1] ?? null };
    return undefined;
  },
  subscript: (node) => node.type === "array_access" ? node.childForFieldName("array") : null,
  loop: (node) => {
    if (node.type !== "enhanced_for_statement") return [];
    const name = node.childForFieldName("name");
    const type = node.childForFieldName("type");
    return name === null ? [] : [{ name, type: type?.text === "var" ? null : type, source: node.childForFieldName("value") }];
  },
  lambdaParam: (lambda) => {
    if (lambda.type !== "lambda_expression") return null;
    const parameters = lambda.childForFieldName("parameters");
    if (parameters === null) return null;
    if (parameters.type === "identifier") return parameters;
    const first = childrenOf(parameters).find((child) => child.isNamed);
    return first?.type === "identifier" ? first : null;
  },
  callbackMethods: ["forEach", "map", "filter", "anyMatch", "allMatch", "noneMatch", "removeIf", "sort", "flatMap", "mapToInt", "mapToLong", "mapToObj", "peek", "takeWhile", "dropWhile", "sorted", "min", "max", "reduce", "ifPresent", "orElseGet"],
  scopeNodes: ["block", "for_statement", "enhanced_for_statement", "if_statement", "try_statement", "catch_clause"],
  classNodes: ["class_declaration", "interface_declaration", "enum_declaration", "record_declaration"],
  thisNodes: ["this"],
  typeBounds: (parameter) => {
    if (parameter.type !== "type_parameter") return undefined;
    const name = childrenOf(parameter).find((child) => child.type === "type_identifier")?.text;
    const bound = childrenOf(parameter).find((child) => child.type === "type_bound");
    return name === undefined ? undefined : { name, bounds: bound === undefined ? [] : childrenOf(bound).filter((child) => child.isNamed) };
  },
  isStatic: modifiersStatic,
  parameter: (node) => {
    if (node.type !== "formal_parameter" && node.type !== "spread_parameter" && node.type !== "catch_formal_parameter") return undefined;
    const name = node.childForFieldName("name") ?? childrenOf(node).find((child) => child.type === "identifier");
    return name !== undefined && name !== null ? { name, type: node.childForFieldName("type") } : undefined;
  },
  typeName: (node) => node?.type === "type_identifier" ? node.text : node?.type === "generic_type" ? (childrenOf(node).find((child) => child.type === "type_identifier")?.text) : node?.type === "array_type" ? undefined : undefined,
  returnType: (fn) => fn.type === "method_declaration" ? fn.childForFieldName("type") : null,
  receiver: () => undefined,
  memberKind: (fn) => fn.type === "method_declaration" ? (modifiersStatic(fn) ? "static" : "instance") : fn.type === "constructor_declaration" ? "static" : undefined,
  local: (node) => {
    if (node.type !== "local_variable_declaration") return [];
    const type = node.childForFieldName("type");
    const declared = type?.type === "type_identifier" && type.text !== "var" ? type : null;
    return childrenOf(node).filter((child) => child.type === "variable_declarator").flatMap((declarator) => {
      const name = declarator.childForFieldName("name");
      return name === null ? [] : [{ name, type: declared, value: declarator.childForFieldName("value") }];
    });
  },
  constructed: (value) => value?.type === "object_creation_expression" ? javaSpec.typeName(value.childForFieldName("type")) : undefined,
  callee: (fn) => {
    if (fn.type !== "method_invocation") return undefined;
    const name = fn.childForFieldName("name");
    if (name === null) return undefined;
    return { object: fn.childForFieldName("object"), name: name.text };
  },
  bases: (classNode) => {
    const superclass = classNode.childForFieldName("superclass");
    const type = superclass === null ? null : childrenOf(superclass).find((child) => child.type === "type_identifier" || child.type === "generic_type") ?? null;
    const name = type === null ? undefined : type.type === "type_identifier" ? type.text : childrenOf(type).find((child) => child.type === "type_identifier")?.text;
    return name === undefined ? [] : [name];
  },
  imports: (node) => {
    if (node.type !== "import_declaration") return [];
    const path = childrenOf(node).find((child) => child.type === "scoped_identifier");
    if (path === undefined || childrenOf(node).some((child) => child.type === "asterisk")) return [];
    const name = path.childForFieldName("name")?.text;
    const scope = path.childForFieldName("scope")?.text;
    return name === undefined || scope === undefined || childrenOf(node).some((child) => child.type === "static") ? [] : [{ local: name, source: `${scope}.${name}`, name }];
  },
  field: (node) => {
    if (node.type !== "field_declaration") return [];
    const type = node.childForFieldName("type");
    return childrenOf(node).filter((child) => child.type === "variable_declarator").flatMap((declarator) => {
      const name = declarator.childForFieldName("name")?.text;
      return name === undefined ? [] : [{ name, type, isStatic: modifiersStatic(node) }];
    });
  },
};

export const csharpSpec: TypedSpec = {
  functionNodes: ["method_declaration", "constructor_declaration", "local_function_statement", "lambda_expression", "anonymous_method_expression"],
  contents: (type) => {
    let current = type;
    while (current !== null && current.type === "nullable_type") current = childrenOf(current)[0] ?? null;
    if (current === null) return undefined;
    if (current.type === "array_type") return { element: current.childForFieldName("type") };
    if (current.type === "qualified_name") current = current.childForFieldName("name");
    if (current === null || current.type !== "generic_name") return undefined;
    const name = childrenOf(current).find((child) => child.type === "identifier")?.text;
    const arguments_ = childrenOf(childrenOf(current).find((child) => child.type === "type_argument_list") ?? current).filter((child) => child.isNamed);
    if (name !== undefined && ["List", "IList", "IEnumerable", "ICollection", "IReadOnlyList", "IReadOnlyCollection", "HashSet", "ISet", "IReadOnlySet", "Queue", "Stack", "ImmutableArray", "ImmutableList", "ImmutableHashSet", "IImmutableList", "IImmutableSet", "Collection", "ObservableCollection", "LinkedList", "SortedSet", "Span", "ReadOnlySpan", "Memory", "ReadOnlyMemory", "IOrderedEnumerable", "IQueryable"].includes(name)) return { element: arguments_[0] ?? null };
    if (name !== undefined && ["Dictionary", "IDictionary", "IReadOnlyDictionary", "ImmutableDictionary", "IImmutableDictionary", "ConcurrentDictionary", "SortedDictionary", "SortedList"].includes(name)) return { value: arguments_[1] ?? null };
    return undefined;
  },
  subscript: (node) => node.type === "element_access_expression" ? node.childForFieldName("expression") : null,
  loop: (node) => {
    if (node.type !== "for_each_statement") return [];
    const name = node.childForFieldName("left");
    const type = node.childForFieldName("type");
    return name?.type === "identifier" ? [{ name, type: type === null || type.type === "implicit_type" ? null : type, source: node.childForFieldName("right") }] : [];
  },
  lambdaParam: (lambda) => {
    if (lambda.type !== "lambda_expression") return null;
    const parameters = lambda.childForFieldName("parameters") ?? childrenOf(lambda).find((child) => child.type === "identifier" || child.type === "parameter_list") ?? null;
    if (parameters === null) return null;
    if (parameters.type === "identifier") return parameters;
    const first = childrenOf(parameters).find((child) => child.isNamed);
    if (first === undefined) return null;
    if (first.type === "identifier") return first;
    return first.type === "parameter" && first.childForFieldName("type") === null ? first.childForFieldName("name") : null;
  },
  callbackMethods: ["ForEach", "Where", "Select", "SelectMany", "Any", "All", "First", "FirstOrDefault", "Last", "LastOrDefault", "Single", "SingleOrDefault", "Count", "OrderBy", "OrderByDescending", "ThenBy", "ThenByDescending", "GroupBy", "TakeWhile", "SkipWhile", "Find", "FindAll", "FindIndex", "Exists", "RemoveAll", "Sum", "Max", "Min", "MaxBy", "MinBy", "ToDictionary", "ToLookup", "Aggregate", "Distinct", "DistinctBy", "TrueForAll", "ConvertAll"],
  typeBounds: (parameter) => {
    if (parameter.type !== "type_parameter") return undefined;
    const name = parameter.childForFieldName("name")?.text ?? childrenOf(parameter).find((child) => child.type === "identifier")?.text;
    return name === undefined ? undefined : { name, bounds: [] };
  },
  whereBounds: (declaration, name) => childrenOf(declaration)
    .filter((child) => child.type === "type_parameter_constraints_clause" && child.childForFieldName("target")?.text === name)
    .flatMap((clause) => childrenOf(clause).filter((child) => child.type === "type_parameter_constraint"))
    .flatMap((constraint) => childrenOf(constraint).filter((child) => child.type === "type_constraint"))
    .map((constraint) => constraint.childForFieldName("type") ?? childrenOf(constraint).find((child) => child.isNamed) ?? null)
    .filter((node): node is Node => node !== null),
  scopeNodes: ["block", "for_statement", "for_each_statement", "if_statement", "try_statement", "catch_clause", "using_statement"],
  classNodes: ["class_declaration", "struct_declaration", "record_declaration", "interface_declaration"],
  thisNodes: ["this_expression"],
  isStatic: modifiersStatic,
  parameter: (node) => {
    if (node.type !== "parameter") return undefined;
    const name = node.childForFieldName("name");
    return name === null ? undefined : { name, type: node.childForFieldName("type") };
  },
  typeName: (node) => node?.type === "identifier" ? node.text : node?.type === "nullable_type" ? csharpSpec.typeName(childrenOf(node)[0] ?? null) : node?.type === "generic_name" ? childrenOf(node).find((child) => child.type === "identifier")?.text : undefined,
  returnType: (fn) => fn.type === "method_declaration" || fn.type === "local_function_statement" ? fn.childForFieldName("type") : null,
  receiver: () => undefined,
  memberKind: (fn) => fn.type === "method_declaration" ? (modifiersStatic(fn) ? "static" : "instance") : fn.type === "constructor_declaration" ? "static" : undefined,
  local: (node) => {
    if (node.type !== "variable_declaration") return [];
    const type = node.childForFieldName("type");
    const declared = type?.type === "identifier" ? type : null;
    return childrenOf(node).filter((child) => child.type === "variable_declarator").flatMap((declarator) => {
      const name = childrenOf(declarator).find((child) => child.type === "identifier");
      const value = childrenOf(childrenOf(declarator).find((child) => child.type === "equals_value_clause") ?? declarator).find((child) => child.type !== "=" && child.type !== "identifier") ?? null;
      return name === undefined ? [] : [{ name, type: declared, value: value === null || value.type === "identifier" ? null : value }];
    });
  },
  constructed: (value) => value?.type === "object_creation_expression" ? csharpSpec.typeName(value.childForFieldName("type")) : undefined,
  callee: (fn) => {
    if (fn.type === "identifier") return { object: null, name: fn.text };
    if (fn.type !== "member_access_expression") return undefined;
    const name = fn.childForFieldName("name");
    const object = fn.childForFieldName("expression");
    return name === null || object === null ? undefined : { object, name: name.text };
  },
  imports: () => [],
  bases: (classNode) => {
    const list = childrenOf(classNode).find((child) => child.type === "base_list");
    const first = list === undefined ? undefined : childrenOf(list).find((child) => child.type === "identifier" || child.type === "generic_name" || child.type === "qualified_name");
    if (first === undefined) return [];
    const name = first.type === "identifier" ? first.text : first.type === "generic_name" ? childrenOf(first).find((child) => child.type === "identifier")?.text : first.text.split(".").pop();
    return name === undefined ? [] : [name];
  },
  field: (node) => {
    if (node.type === "property_declaration") {
      const name = node.childForFieldName("name")?.text;
      return name === undefined ? [] : [{ name, type: node.childForFieldName("type"), isStatic: modifiersStatic(node) }];
    }
    if (node.type !== "field_declaration") return [];
    const declaration = childrenOf(node).find((child) => child.type === "variable_declaration");
    if (declaration === undefined) return [];
    const type = declaration.childForFieldName("type");
    return childrenOf(declaration).filter((child) => child.type === "variable_declarator").flatMap((declarator) => {
      const name = childrenOf(declarator).find((child) => child.type === "identifier")?.text;
      return name === undefined ? [] : [{ name, type, isStatic: modifiersStatic(node) }];
    });
  },
};
