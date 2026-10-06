import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extensionLanguage } from "../src/grammar/languages.js";

// The grep-versus-graph paragraph counts its call-site sets and their languages in words. The
// table grew from five languages to six without the sentence following, so derive both counts
// from the record the table cites.
const root = fileURLToPath(new URL("..", import.meta.url));
const record = JSON.parse(readFileSync(path.join(root, "benchmarks", "results", "grep-vs-graph-2026-09-21.json"), "utf8")) as {
  cases: { symbol: string }[];
};
const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const documents = ["README.md", path.join("docs", "reference.md"), path.join("site", "public", "index.html")];

it("states the record's call-site set and language counts wherever the comparison is summarized", () => {
  const languages = new Set(record.cases.map(({ symbol }) => extensionLanguage[path.extname(symbol.split("#")[0]!)]));
  expect(languages.has(undefined)).toBe(false);
  const expected = `${words[record.cases.length]} call-site sets in ${words[languages.size]} languages`;
  const claims = documents.map((file) => {
    const text = readFileSync(path.join(root, file), "utf8");
    const match = /(\w+) call-site sets (?:on public checkouts )?in (\w+) languages/i.exec(text);
    return [file, match && `${match[1]!.toLowerCase()} call-site sets in ${match[2]!.toLowerCase()} languages`];
  });
  expect(claims).toEqual(documents.map((file) => [file, expected]));
});
