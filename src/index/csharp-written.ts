// Checks a C# type as `ArgumentTypes.receiver` and `ParameterRange.receiver` write it: a dotted name of identifiers,
// each segment with optional type arguments, optionally after an `alias::` qualifier, then any number of `?` and `[]`
// (`[,]`) suffixes; or `this`.

const IDENTIFIER = /^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}\p{Cf}]*/u;

export function validWrittenCsharpType(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return false;
  if (value === "this") return true;
  let at = 0;
  const identifier = (): boolean => {
    const match = IDENTIFIER.exec(value.slice(at));
    if (match === null) return false;
    at += match[0].length;
    return true;
  };
  const type = (depth: number): boolean => {
    if (depth > 16 || !identifier()) return false;
    if (value.startsWith("::", at)) { at += 2; if (!identifier()) return false; }
    for (;;) {
      if (value[at] === "<") {
        at += 1;
        if (!type(depth + 1)) return false;
        while (value[at] === ",") { at += 1; if (!type(depth + 1)) return false; }
        if (value[at] !== ">") return false;
        at += 1;
      }
      if (value[at] !== ".") break;
      at += 1;
      if (!identifier()) return false;
    }
    for (;;) {
      if (value[at] === "?") { at += 1; continue; }
      if (value[at] === "[") {
        at += 1;
        while (value[at] === ",") at += 1;
        if (value[at] !== "]") return false;
        at += 1;
        continue;
      }
      return true;
    }
  };
  return type(0) && at === value.length;
}

// Checks one C# argument type as `ArgumentTypes.types` writes it: a written type, `#null`, `#named`, `#ref`,
// `#lit:<int|uint|long|ulong>:<value>` or `=` and a dotted name of two or more identifiers.
export function validCsharpArgumentType(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value === "#null" || value === "#named" || value === "#ref") return true;
  if (/^#lit:(?:int|uint|long|ulong):-?\d{1,20}$/u.test(value)) return true;
  if (value.startsWith("=")) {
    const parts = value.slice(1).split(".");
    return value.length <= 512 && parts.length >= 2 && parts.every((part) => IDENTIFIER.exec(part)?.[0] === part);
  }
  return validWrittenCsharpType(value);
}

// Checks one C# parameter as `ParameterRange.written` writes it: `[ref |out |in |params ]<type>[=]`, the type a written
// type or `?`.
export function validCsharpParameterType(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(?:(?:ref|out|in|params) )?(.+?)(=?)$/u.exec(value);
  if (match === null) return false;
  const type = match[1]!;
  return (type === "?" || (type !== "this" && validWrittenCsharpType(type))) && !(value.startsWith("params ") && match[2] === "=");
}
