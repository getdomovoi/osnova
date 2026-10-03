// Java overload choice from written types: JLS 15.12.2 applicability by strict (phase 1), loose (phase 2) and
// variable-arity (phase 3) invocation, then the most specific method, over erased types. Every relation answers
// true, false, or null when the index cannot tell, and a null that could change the choice leaves it undecided.

const PRIMITIVES = new Set(["boolean", "byte", "char", "short", "int", "long", "float", "double"]);
const BOXED: Readonly<Record<string, string>> = { boolean: "java.lang.Boolean", byte: "java.lang.Byte", char: "java.lang.Character", short: "java.lang.Short",
  int: "java.lang.Integer", long: "java.lang.Long", float: "java.lang.Float", double: "java.lang.Double" };
const UNBOXED: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(BOXED).map(([primitive, boxed]) => [boxed, primitive]));
// Widening primitive conversion (JLS 5.1.2).
const WIDENS: Readonly<Record<string, readonly string[]>> = { byte: ["short", "int", "long", "float", "double"], short: ["int", "long", "float", "double"],
  char: ["int", "long", "float", "double"], int: ["long", "float", "double"], long: ["float", "double"], float: ["double"], double: [], boolean: [] };

// Every direct supertype (superclass and interfaces) of the JDK types the table covers, as of Java 21; a type the table
// does not list has unknown supertypes. Nested names use dots, as parameter types write them.
const OBJECT = "java.lang.Object";
const JDK_SUPERTYPES: Readonly<Record<string, readonly string[]>> = {
  [OBJECT]: [],
  "java.lang.String": [OBJECT, "java.io.Serializable", "java.lang.Comparable", "java.lang.CharSequence", "java.lang.constant.Constable", "java.lang.constant.ConstantDesc"],
  "java.lang.Number": [OBJECT, "java.io.Serializable"],
  "java.lang.Integer": ["java.lang.Number", "java.lang.Comparable", "java.lang.constant.Constable", "java.lang.constant.ConstantDesc"],
  "java.lang.Long": ["java.lang.Number", "java.lang.Comparable", "java.lang.constant.Constable", "java.lang.constant.ConstantDesc"],
  "java.lang.Float": ["java.lang.Number", "java.lang.Comparable", "java.lang.constant.Constable", "java.lang.constant.ConstantDesc"],
  "java.lang.Double": ["java.lang.Number", "java.lang.Comparable", "java.lang.constant.Constable", "java.lang.constant.ConstantDesc"],
  "java.lang.Short": ["java.lang.Number", "java.lang.Comparable", "java.lang.constant.Constable"],
  "java.lang.Byte": ["java.lang.Number", "java.lang.Comparable", "java.lang.constant.Constable"],
  "java.lang.Boolean": [OBJECT, "java.io.Serializable", "java.lang.Comparable", "java.lang.constant.Constable"],
  "java.lang.Character": [OBJECT, "java.io.Serializable", "java.lang.Comparable", "java.lang.constant.Constable"],
  "java.lang.Class": [OBJECT, "java.io.Serializable", "java.lang.reflect.GenericDeclaration", "java.lang.reflect.Type", "java.lang.reflect.AnnotatedElement",
    "java.lang.invoke.TypeDescriptor.OfField", "java.lang.constant.Constable"],
  "java.lang.reflect.GenericDeclaration": ["java.lang.reflect.AnnotatedElement"],
  "java.lang.reflect.AnnotatedElement": [], "java.lang.reflect.Type": [],
  "java.lang.reflect.ParameterizedType": ["java.lang.reflect.Type"], "java.lang.reflect.GenericArrayType": ["java.lang.reflect.Type"],
  "java.lang.reflect.WildcardType": ["java.lang.reflect.Type"], "java.lang.reflect.TypeVariable": ["java.lang.reflect.Type", "java.lang.reflect.AnnotatedElement"],
  "java.lang.invoke.TypeDescriptor.OfField": ["java.lang.invoke.TypeDescriptor"], "java.lang.invoke.TypeDescriptor": [],
  "java.lang.CharSequence": [], "java.lang.Comparable": [], "java.io.Serializable": [], "java.lang.constant.Constable": [], "java.lang.constant.ConstantDesc": [],
  "java.lang.Appendable": [], "java.lang.Readable": [], "java.lang.AutoCloseable": [], "java.io.Closeable": ["java.lang.AutoCloseable"], "java.io.Flushable": [],
  "java.lang.Cloneable": [], "java.lang.Iterable": [], "java.lang.Runnable": [],
  "java.lang.AbstractStringBuilder": [OBJECT, "java.lang.Appendable", "java.lang.CharSequence"],
  "java.lang.StringBuilder": ["java.lang.AbstractStringBuilder", "java.io.Serializable", "java.lang.Comparable", "java.lang.CharSequence"],
  "java.lang.StringBuffer": ["java.lang.AbstractStringBuilder", "java.io.Serializable", "java.lang.Comparable", "java.lang.CharSequence"],
  "java.lang.Enum": [OBJECT, "java.lang.Comparable", "java.io.Serializable", "java.lang.constant.Constable"], "java.lang.Record": [OBJECT],
  "java.io.Reader": [OBJECT, "java.lang.Readable", "java.io.Closeable"], "java.io.StringReader": ["java.io.Reader"], "java.io.BufferedReader": ["java.io.Reader"],
  "java.io.InputStreamReader": ["java.io.Reader"], "java.io.FileReader": ["java.io.InputStreamReader"], "java.io.CharArrayReader": ["java.io.Reader"],
  "java.io.FilterReader": ["java.io.Reader"], "java.io.PushbackReader": ["java.io.FilterReader"],
  "java.io.Writer": [OBJECT, "java.lang.Appendable", "java.io.Closeable", "java.io.Flushable"], "java.io.StringWriter": ["java.io.Writer"],
  "java.io.PrintWriter": ["java.io.Writer"], "java.io.OutputStreamWriter": ["java.io.Writer"], "java.io.FileWriter": ["java.io.OutputStreamWriter"],
  "java.io.BufferedWriter": ["java.io.Writer"], "java.io.CharArrayWriter": ["java.io.Writer"], "java.io.FilterWriter": ["java.io.Writer"],
  "java.io.InputStream": [OBJECT, "java.io.Closeable"], "java.io.OutputStream": [OBJECT, "java.io.Closeable", "java.io.Flushable"],
  "java.io.ByteArrayInputStream": ["java.io.InputStream"], "java.io.ByteArrayOutputStream": ["java.io.OutputStream"],
  "java.util.Collection": ["java.lang.Iterable"], "java.util.SequencedCollection": ["java.util.Collection"], "java.util.List": ["java.util.SequencedCollection"],
  "java.util.Set": ["java.util.Collection"], "java.util.SequencedSet": ["java.util.SequencedCollection", "java.util.Set"],
  "java.util.SortedSet": ["java.util.Set", "java.util.SequencedSet"], "java.util.NavigableSet": ["java.util.SortedSet"],
  "java.util.Queue": ["java.util.Collection"], "java.util.Deque": ["java.util.Queue", "java.util.SequencedCollection"],
  "java.util.Map": [], "java.util.SequencedMap": ["java.util.Map"], "java.util.SortedMap": ["java.util.SequencedMap", "java.util.Map"], "java.util.NavigableMap": ["java.util.SortedMap"],
  "java.util.RandomAccess": [],
  "java.util.AbstractCollection": [OBJECT, "java.util.Collection"], "java.util.AbstractList": ["java.util.AbstractCollection", "java.util.List"],
  "java.util.AbstractSequentialList": ["java.util.AbstractList"], "java.util.AbstractSet": ["java.util.AbstractCollection", "java.util.Set"], "java.util.AbstractMap": [OBJECT, "java.util.Map"],
  "java.util.ArrayList": ["java.util.AbstractList", "java.util.List", "java.util.RandomAccess", "java.lang.Cloneable", "java.io.Serializable"],
  "java.util.LinkedList": ["java.util.AbstractSequentialList", "java.util.List", "java.util.Deque", "java.lang.Cloneable", "java.io.Serializable"],
  "java.util.HashSet": ["java.util.AbstractSet", "java.util.Set", "java.lang.Cloneable", "java.io.Serializable"],
  "java.util.LinkedHashSet": ["java.util.HashSet", "java.util.SequencedSet", "java.lang.Cloneable", "java.io.Serializable"],
  "java.util.TreeSet": ["java.util.AbstractSet", "java.util.NavigableSet", "java.lang.Cloneable", "java.io.Serializable"],
  "java.util.HashMap": ["java.util.AbstractMap", "java.util.Map", "java.lang.Cloneable", "java.io.Serializable"],
  "java.util.LinkedHashMap": ["java.util.HashMap", "java.util.SequencedMap"],
  "java.util.TreeMap": ["java.util.AbstractMap", "java.util.NavigableMap", "java.lang.Cloneable", "java.io.Serializable"],
  "java.util.Date": [OBJECT, "java.io.Serializable", "java.lang.Cloneable", "java.lang.Comparable"],
  "java.math.BigDecimal": ["java.lang.Number", "java.lang.Comparable"], "java.math.BigInteger": ["java.lang.Number", "java.lang.Comparable"],
  "java.lang.Throwable": [OBJECT, "java.io.Serializable"], "java.lang.Exception": ["java.lang.Throwable"], "java.lang.Error": ["java.lang.Throwable"],
  "java.lang.RuntimeException": ["java.lang.Exception"], "java.io.IOException": ["java.lang.Exception"],
  "java.lang.IllegalArgumentException": ["java.lang.RuntimeException"], "java.lang.IllegalStateException": ["java.lang.RuntimeException"],
  "java.lang.NullPointerException": ["java.lang.RuntimeException"], "java.lang.UnsupportedOperationException": ["java.lang.RuntimeException"],
  "java.lang.NumberFormatException": ["java.lang.IllegalArgumentException"], "java.lang.ClassCastException": ["java.lang.RuntimeException"],
  "java.lang.ArithmeticException": ["java.lang.RuntimeException"], "java.lang.IndexOutOfBoundsException": ["java.lang.RuntimeException"],
};
// Final JDK classes: no other type is a subtype of one.
const FINAL = new Set(["java.lang.String", "java.lang.Integer", "java.lang.Long", "java.lang.Short", "java.lang.Byte", "java.lang.Character", "java.lang.Boolean",
  "java.lang.Double", "java.lang.Float", "java.lang.Class", "java.lang.StringBuilder", "java.lang.StringBuffer"]);

export function jdkSupertypes(type: string): readonly string[] | undefined {
  return JDK_SUPERTYPES[type];
}

// The index's view of the types it holds: a declared type's direct supertypes (null for one it cannot follow), or
// undefined for a type the index does not declare.
export interface JavaTypeWorld {
  readonly indexed: (type: string) => boolean;
  readonly supertypes: (type: string) => readonly (string | null)[] | undefined;
}

// Reference subtyping S <: T over erased, non-array class or interface types.
function subtype(world: JavaTypeWorld, s: string, t: string): boolean | null {
  if (s === t || t === OBJECT) return true;
  if (FINAL.has(t)) return false;
  const seen = new Set<string>();
  const pending = [s];
  let unknown = false;
  while (pending.length > 0) {
    const type = pending.pop()!;
    if (seen.has(type)) continue;
    seen.add(type);
    if (seen.size > 64) return null;
    if (type === t) return true;
    const supers = world.indexed(type) ? world.supertypes(type) : JDK_SUPERTYPES[type];
    // A type outside the index and the table has unknown supertypes: an ignored or generated source, or a compiled
    // class, can extend a type the index declares.
    if (supers === undefined) { unknown = true; continue; }
    for (const next of supers) {
      if (next === null) unknown = true;
      else pending.push(next);
    }
  }
  return unknown ? null : false;
}

const isArray = (type: string): boolean => type.endsWith("[]");

// Whether an argument of type `a` is applicable to a parameter of type `p` in phase 1 (strict) or 2 (loose).
function fits(world: JavaTypeWorld, a: string | null, p: string | null, phase: 1 | 2): boolean | null {
  if (a === null || p === null) return null;
  if (a === "null") return !PRIMITIVES.has(p.replace(/^~/u, ""));
  // A type marked `~` is parameterized by type arguments its erasure drops: an erasure that does not fit proves the
  // type does not, one that fits proves nothing.
  if (a.startsWith("~") || p.startsWith("~")) {
    const erased = fits(world, a.replace(/^~/u, ""), p.replace(/^~/u, ""), phase);
    return erased === true ? null : erased;
  }
  if (PRIMITIVES.has(a) && PRIMITIVES.has(p)) return a === p || WIDENS[a]!.includes(p);
  if (PRIMITIVES.has(a)) return phase === 1 || isArray(p) ? false : subtype(world, BOXED[a]!, p);
  if (PRIMITIVES.has(p)) {
    if (phase === 1) return false;
    const unboxed = UNBOXED[a];
    if (unboxed !== undefined) return unboxed === p || WIDENS[unboxed]!.includes(p);
    // Only a boxed type unboxes; a declared or table type is not one, an unknown library type might be a subclass of none.
    return world.indexed(a) || JDK_SUPERTYPES[a] !== undefined ? false : null;
  }
  if (isArray(a) || isArray(p)) {
    if (isArray(a) && !isArray(p)) return p === OBJECT || p === "java.lang.Cloneable" || p === "java.io.Serializable";
    if (!isArray(a)) return a === OBJECT || world.indexed(a) || JDK_SUPERTYPES[a] !== undefined ? false : null;
    const ea = a.slice(0, -2), ep = p.slice(0, -2);
    if (PRIMITIVES.has(ea) || PRIMITIVES.has(ep)) return ea === ep;
    return fits(world, ea, ep, 1);
  }
  return subtype(world, a, p);
}

export interface JavaCandidate<T> {
  readonly item: T;
  // Erased parameter types (null where unknown); a variable-arity method's last one is its array type.
  readonly parameters: readonly (string | null)[];
  readonly variable: boolean;
}

// m1 is more specific than m2 (JLS 15.12.2.5, for fixed-arity methods of the same arity) when each parameter type of
// m1 is a subtype of m2's.
function moreSpecific(world: JavaTypeWorld, m1: readonly (string | null)[], m2: readonly (string | null)[]): boolean | null {
  if (m1.length !== m2.length) return null;
  let all: boolean | null = true;
  for (let i = 0; i < m1.length; i += 1) {
    const answer = fits(world, m1[i]!, m2[i]!, 1);
    if (answer === false) return false;
    if (answer === null) all = null;
  }
  return all;
}

// The candidate a call with these argument types binds, or undefined when the written types cannot decide it.
export function chooseByArgumentTypes<T>(world: JavaTypeWorld, candidates: readonly JavaCandidate<T>[], args: readonly (string | null)[]): T | undefined {
  const n = args.length;
  const applicable = (candidate: JavaCandidate<T>, phase: 1 | 2 | 3): boolean | null => {
    const parameters = candidate.parameters;
    if (phase < 3) {
      if (parameters.length !== n) return false;
      let result: boolean | null = true;
      for (let i = 0; i < n; i += 1) {
        const answer = fits(world, args[i]!, parameters[i]!, phase as 1 | 2);
        if (answer === false) return false;
        if (answer === null) result = null;
      }
      return result;
    }
    if (!candidate.variable || n < parameters.length - 1) return false;
    const fixed = parameters.length - 1;
    const component = parameters[fixed] === null || !parameters[fixed]!.endsWith("[]") ? null : parameters[fixed]!.slice(0, -2);
    let result: boolean | null = true;
    for (let i = 0; i < n; i += 1) {
      const answer = fits(world, args[i]!, i < fixed ? parameters[i]! : component, 2);
      if (answer === false) return false;
      if (answer === null) result = null;
    }
    return result;
  };
  const table = candidates.map((candidate) => [applicable(candidate, 1), applicable(candidate, 2), applicable(candidate, 3)] as const);
  const alive = candidates.filter((_, i) => table[i]!.some((answer) => answer !== false));
  // The code compiles, so when one candidate alone is not ruled out it is the one bound.
  if (alive.length === 1) return alive[0]!.item;
  if (alive.length === 0) return undefined;
  for (const phase of [0, 1, 2] as const) {
    const yes = candidates.filter((_, i) => table[i]![phase] === true);
    const maybe = candidates.filter((_, i) => table[i]![phase] === null);
    if (yes.length === 0 && maybe.length === 0) continue;
    // A phase only some unknown argument might satisfy may or may not be the one that decides.
    if (yes.length === 0) return undefined;
    if (phase === 2) return yes.length + maybe.length === 1 ? yes[0]!.item : undefined;
    const contenders = [...yes, ...maybe];
    const best = yes.filter((candidate) => contenders.every((other) => other === candidate || moreSpecific(world, candidate.parameters, other.parameters) === true));
    return best.length === 1 ? best[0]!.item : undefined;
  }
  return undefined;
}

// Exposed for tests.
export const javaTypeRules = { subtype, fits };
