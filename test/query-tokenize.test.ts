import { describe, expect, it } from "vitest";
import { tokenize } from "../src/query/context.js";

describe("tokenize", () => {
  it("splits an identifier on its camel humps", () => {
    expect(tokenize("fooBarBaz")).toEqual(["foo", "bar", "baz"]);
    expect(tokenize("parseHTTPResponse")).toEqual(["parse", "http", "response"]);
    expect(tokenize("XMLHttpRequest")).toEqual(["xml", "http", "request"]);
    expect(tokenize("v2Point3D")).toEqual(["v2", "point3"]);
  });

  it("splits on every character that is not a letter or a digit", () => {
    expect(tokenize("snake_case_name")).toEqual(["snake", "case", "name"]);
    expect(tokenize("kebab-case-name")).toEqual(["kebab", "case", "name"]);
    expect(tokenize("a.b/c:d")).toEqual([]);
    expect(tokenize("CONSTANT_VALUE")).toEqual(["constant", "value"]);
  });

  it("drops a token shorter than two characters, longer than 64, or in the stop list", () => {
    expect(tokenize("a")).toEqual([]);
    expect(tokenize("ab")).toEqual(["ab"]);
    expect(tokenize("x".repeat(64))).toEqual(["x".repeat(64)]);
    expect(tokenize("x".repeat(65))).toEqual([]);
    expect(tokenize("the quick brown fox")).toEqual(["quick", "brown", "fox"]);
  });

  it("keeps the letters a non-ASCII character lowercases into", () => {
    // `İ` lowercases to `i` plus a combining dot, so the `i` survives as its own token boundary.
    expect(tokenize("fİrLLxARb")).toEqual(["fi", "lx", "rb"]);
    expect(tokenize("École")).toEqual(["cole"]);
    expect(tokenize("中文abc")).toEqual(["abc"]);
  });
});
