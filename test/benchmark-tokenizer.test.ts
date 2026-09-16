import { expect, it } from "vitest";
import { responseTokens } from "../scripts/bench/tokenizer.js";

it("measures a named encoding rather than estimating from characters", () => {
  expect(responseTokens("hello world")).toEqual({ encoding: "cl100k_base", count: 2 });
  expect(responseTokens("")).toEqual({ encoding: "cl100k_base", count: 0 });
  expect(responseTokens("abc")).toEqual({ encoding: "cl100k_base", count: 1 });
});

it("treats token-looking source text as ordinary content", () => {
  expect(responseTokens("<|endoftext|>").count).toBeGreaterThan(1);
  expect(responseTokens("\u{1F680} unicode content").count).toBeGreaterThan(0);
});
