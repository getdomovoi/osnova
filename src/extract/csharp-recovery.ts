import type { Parser, Range, Tree } from "web-tree-sitter";

// The bundled C# grammar predates primary constructors on classes and structs (C# 12) and raw string
// literals (C# 11); either one turns the rest of a file into ERROR nodes. A second parse leaves out only
// the text the grammar cannot read: a primary constructor's parameter list and its base-type arguments,
// and the body of a raw string (one quote stays at each end; a single-line interpolation hole without
// quotes or braces stays readable). Offsets are untouched, so every span and node text is the source's own.
export type ExcludedSpan = readonly [start: number, end: number];

const identifierStart = /[\p{L}\p{Nl}_]/u;
const identifierPart = /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}\p{Cf}]/u;
const stringPrefix = /^(?:\$*@?|@\$+)$/;

class Scanner {
  constructor(readonly text: string, readonly spans: ExcludedSpan[]) {}

  exclude(start: number, end: number): void {
    if (start < end) this.spans.push([start, end]);
  }

  atLineStart(i: number): boolean {
    for (let j = i - 1; j >= 0; j -= 1) {
      const c = this.text[j];
      if (c === "\n") return true;
      if (c !== " " && c !== "\t" && c !== "\r") return false;
    }
    return true;
  }

  lineEnd(i: number): number {
    const end = this.text.indexOf("\n", i);
    return end < 0 ? this.text.length : end;
  }

  // Whitespace and comments.
  trivia(i: number): number {
    const t = this.text;
    while (i < t.length) {
      const c = t[i];
      if (c === " " || c === "\t" || c === "\r" || c === "\n") i += 1;
      else if (c === "/" && t[i + 1] === "/") i = this.lineEnd(i);
      else if (c === "/" && t[i + 1] === "*") {
        const end = t.indexOf("*/", i + 2);
        i = end < 0 ? t.length : end + 2;
      } else return i;
    }
    return i;
  }

  word(i: number): number {
    const t = this.text;
    if (!identifierStart.test(t[i] ?? "")) return i;
    let j = i + 1;
    while (j < t.length && identifierPart.test(t[j] ?? "")) j += 1;
    return j;
  }

  charLiteral(i: number): number {
    const t = this.text;
    let j = i + 1;
    while (j < t.length && t[j] !== "'" && t[j] !== "\n") j += t[j] === "\\" ? 2 : 1;
    return Math.min(j + 1, t.length);
  }

  startsString(i: number): boolean {
    const t = this.text;
    let j = i;
    while (t[j] === "$" || t[j] === "@") j += 1;
    return t[j] === "\"" && stringPrefix.test(t.slice(i, j));
  }

  // A string literal starting at i, prefix included; returns the index after it.
  string(i: number): number {
    const t = this.text;
    let j = i;
    let dollars = 0;
    let verbatim = false;
    while (t[j] === "$" || t[j] === "@") {
      if (t[j] === "$") dollars += 1;
      else verbatim = true;
      j += 1;
    }
    let quotes = 0;
    while (t[j + quotes] === "\"") quotes += 1;
    if (!verbatim && quotes >= 3) return this.raw(i, j, quotes, dollars);
    let k = j + 1;
    while (k < t.length) {
      const c = t[k];
      if (verbatim) {
        if (c === "\"") {
          if (t[k + 1] !== "\"") return k + 1;
          k += 2;
          continue;
        }
      } else {
        if (c === "\\") { k += 2; continue; }
        if (c === "\"") return k + 1;
        if (c === "\n") return k;
      }
      if (dollars > 0 && c === "{") {
        if (t[k + 1] === "{") { k += 2; continue; }
        k = this.code(k + 1, true) + 1;
        continue;
      }
      k += 1;
    }
    return t.length;
  }

  raw(start: number, firstQuote: number, quotes: number, dollars: number): number {
    const t = this.text;
    const spansBefore = this.spans.length;
    if (dollars > 1) this.exclude(start, start + dollars - 1);
    let excludeFrom = firstQuote + 1;
    let k = firstQuote + quotes;
    while (k < t.length) {
      const c = t[k];
      if (c === "\"") {
        let run = 0;
        while (t[k + run] === "\"") run += 1;
        if (run >= quotes) {
          this.exclude(excludeFrom, k + run - 1);
          return k + run;
        }
        k += run;
        continue;
      }
      if (dollars > 0 && c === "{") {
        let run = 0;
        while (t[k + run] === "{") run += 1;
        if (run < dollars) { k += run; continue; }
        const open = k + run - 1;
        const close = new Scanner(t, []).code(open + 1, true);
        if (!/["'\n{}]/.test(t.slice(open + 1, close))) {
          this.exclude(excludeFrom, open);
          excludeFrom = close + 1;
        }
        k = close;
        for (let closing = 0; closing < dollars && t[k] === "}"; closing += 1) k += 1;
        continue;
      }
      k += 1;
    }
    // Unterminated: leave the rest of the file to the grammar rather than hide it.
    this.spans.length = spansBefore;
    return t.length;
  }

  // Balanced parentheses from the "(" at i; returns the index after the ")" or -1 when unbalanced.
  parens(i: number): number {
    const t = this.text;
    const inner = new Scanner(t, []);
    let depth = 0;
    let k = i;
    while (k < t.length) {
      const c = t[k];
      if (c === "/" && (t[k + 1] === "/" || t[k + 1] === "*")) { k = inner.trivia(k); continue; }
      if (c === "'") { k = inner.charLiteral(k); continue; }
      if ((c === "\"" || c === "$" || c === "@") && inner.startsString(k)) { k = inner.string(k); continue; }
      if (c === "(") depth += 1;
      else if (c === ")") {
        depth -= 1;
        if (depth === 0) return k + 1;
      } else if (c === "{" || c === "}" || c === ";") return -1;
      k += 1;
    }
    return -1;
  }

  angles(i: number): number {
    const t = this.text;
    let depth = 0;
    for (let k = i; k < t.length; k += 1) {
      const c = t[k];
      if (c === "<") depth += 1;
      else if (c === ">") {
        depth -= 1;
        if (depth === 0) return k + 1;
      } else if (c === "{" || c === "}" || c === ";" || c === "(" || c === ")" || c === "\"") return -1;
    }
    return -1;
  }

  // A base type name such as `A.B<C>` or `global::A.B`; returns the index after it.
  typeName(i: number): number {
    const t = this.text;
    let k = this.word(i);
    if (k === i) return i;
    for (;;) {
      const next = this.trivia(k);
      if (t[next] === "<") {
        const end = this.angles(next);
        if (end < 0) return k;
        k = end;
        continue;
      }
      if (t[next] === "." || (t[next] === ":" && t[next + 1] === ":")) {
        const after = this.trivia(next + (t[next] === "." ? 1 : 2));
        const end = this.word(after);
        if (end === after) return k;
        k = end;
        continue;
      }
      return k;
    }
  }

  // After the keyword `class` or `struct`: a primary constructor's parameters and the base type's arguments.
  typeHeader(i: number): number {
    const t = this.text;
    const nameStart = this.trivia(i);
    const nameEnd = this.word(nameStart);
    if (nameEnd === nameStart) return i;
    let k = this.trivia(nameEnd);
    if (t[k] === "<") {
      const end = this.angles(k);
      if (end < 0) return nameEnd;
      k = this.trivia(end);
    }
    if (t[k] !== "(") return nameEnd;
    const close = this.parens(k);
    if (close < 0) return nameEnd;
    this.exclude(k, close);
    let next = this.trivia(close);
    if (t[next] !== ":" || t[next + 1] === ":") return close;
    next = this.typeName(this.trivia(next + 1));
    const argumentsStart = this.trivia(next);
    if (t[argumentsStart] !== "(") return next;
    const argumentsEnd = this.parens(argumentsStart);
    if (argumentsEnd < 0) return next;
    this.exclude(argumentsStart, argumentsEnd);
    return argumentsEnd;
  }

  // Code from i; in an interpolation hole, stops at the hole's closing brace (or its format clause's).
  code(i: number, inHole: boolean): number {
    const t = this.text;
    let braces = 0;
    let parens = 0;
    let previousWord = "";
    let previousChar = "";
    let k = i;
    while (k < t.length) {
      const c = t[k] ?? "";
      if (c === "/" && (t[k + 1] === "/" || t[k + 1] === "*")) { k = this.trivia(k); continue; }
      if (c === " " || c === "\t" || c === "\r" || c === "\n") { k += 1; continue; }
      if (c === "#" && !inHole && this.atLineStart(k)) { k = this.lineEnd(k); continue; }
      if (c === "'") { k = this.charLiteral(k); previousWord = ""; previousChar = c; continue; }
      if ((c === "\"" || c === "$" || c === "@") && this.startsString(k)) { k = this.string(k); previousWord = ""; previousChar = "\""; continue; }
      if (c === "@" && identifierStart.test(t[k + 1] ?? "")) { k = this.word(k + 1); previousWord = ""; previousChar = "w"; continue; }
      if (identifierStart.test(c)) {
        const end = this.word(k);
        const word = t.slice(k, end);
        k = (word === "class" || word === "struct") && previousChar !== "." && previousWord !== "record" ? this.typeHeader(end) : end;
        previousWord = word;
        previousChar = "w";
        continue;
      }
      if (inHole) {
        if (c === "{") braces += 1;
        else if (c === "}") {
          if (braces === 0) return k;
          braces -= 1;
        } else if (c === "(" || c === "[") parens += 1;
        else if (c === ")" || c === "]") parens -= 1;
        else if (c === ":" && braces === 0 && parens <= 0) {
          if (t[k + 1] !== ":") {
            const close = t.indexOf("}", k);
            return close < 0 ? t.length : close;
          }
          k += 1;
        }
      }
      previousWord = "";
      previousChar = c;
      k += 1;
    }
    return t.length;
  }
}

export function csharpExcludedSpans(text: string): ExcludedSpan[] {
  const spans: ExcludedSpan[] = [];
  new Scanner(text, spans).code(0, false);
  return spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

// The complement of the excluded spans, as tree-sitter ranges in UTF-16 code units.
export function includedRanges(text: string, spans: readonly ExcludedSpan[]): Range[] {
  const lineStarts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  let line = 0;
  const point = (index: number) => {
    while (line + 1 < lineStarts.length && (lineStarts[line + 1] ?? Infinity) <= index) line += 1;
    return { row: line, column: index - (lineStarts[line] ?? 0) };
  };
  const ranges: Range[] = [];
  let at = 0;
  for (const [start, end] of spans) {
    if (start < at) continue;
    if (start > at) ranges.push({ startIndex: at, endIndex: start, startPosition: point(at), endPosition: point(start) });
    at = end;
  }
  if (at < text.length) ranges.push({ startIndex: at, endIndex: text.length, startPosition: point(at), endPosition: point(text.length) });
  return ranges;
}

// ERROR nodes (not those nested in another) and MISSING nodes, and the text the ERROR nodes cover.
function errors(tree: Tree): { nodes: number; text: number } {
  let nodes = 0;
  let text = 0;
  const cursor = tree.walk();
  try {
    for (;;) {
      const node = cursor.currentNode;
      if (node.isError || node.isMissing) nodes += 1;
      if (node.isError) text += node.endIndex - node.startIndex;
      if (!node.isError && node.hasError && cursor.gotoFirstChild()) continue;
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) return { nodes, text };
      }
    }
  } finally {
    cursor.delete();
  }
}

// Reparses a C# file whose first parse has errors without the constructs the grammar cannot read. The
// second tree replaces the first unless it has at least as many errors covering at least as much text.
export function recoverCsharpTree(parser: Parser, text: string, tree: Tree): Tree {
  const spans = csharpExcludedSpans(text);
  if (spans.length === 0) return tree;
  const recovered = parser.parse(text, null, { includedRanges: includedRanges(text, spans) });
  if (recovered === null) return tree;
  const before = errors(tree);
  const after = recovered.rootNode.hasError ? errors(recovered) : { nodes: 0, text: 0 };
  if (after.nodes < before.nodes || after.text < before.text) {
    tree.delete();
    return recovered;
  }
  recovered.delete();
  return tree;
}
