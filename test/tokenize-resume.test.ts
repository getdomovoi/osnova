import { describe, expect, it } from "vitest";
import { tokenize, tokenizeUnicode } from "../src/query/context.js";

const ALPHABET = [
  "a", "b", "z", "A", "B", "Z", "0", "7", "_", " ", ".", "-", "/", "\t",
  "é", "É", "İ", "ß", "Σ", "ς", "K", "Å", "中", "😀", "̇",
];

function randomText(seed: number, length: number): string {
  let state = seed >>> 0;
  let out = "";
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out += ALPHABET[state % ALPHABET.length];
  }
  return out;
}

describe("tokenize on text outside ASCII", () => {
  it("matches the regular-expression tokenizer wherever the non-ASCII character sits", () => {
    const fixed = [
      "resolveImportBinding(sourceFile) // café",
      "// café resolveImportBinding(sourceFile)",
      "parseHTTPÉResponse",
      "fooBarİbaz qux",
      "XMLHttpRequest ÅngströmUnit v2Point3D",
      "snake_case_name — kebab-case-name",
      "CONSTANT_VALUE Σigma finalΣ",
      "the quick brown fox jumps 😀 over",
      "x".repeat(70) + "é" + "y".repeat(70),
    ];
    for (const text of fixed) expect(tokenize(text)).toEqual(tokenizeUnicode(text));
    let checked = 0;
    for (let seed = 1; seed <= 4000; seed += 1) {
      const text = randomText(seed, 1 + (seed % 40));
      if (![...text].some((char) => char.charCodeAt(0) >= 128)) continue;
      expect(tokenize(text), JSON.stringify(text)).toEqual(tokenizeUnicode(text));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(3000);
  });
});
