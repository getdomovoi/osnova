import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

// The reference cites one coverage record and then printed the table from the record before it,
// so ten of twenty rows disagreed with the file they claimed to come from. The table is now
// generated from the cited record and this test fails if the two ever part again.
interface LanguageRow { readonly language: string; readonly calls: number; readonly resolved: number; readonly resolvedShare: number; readonly resolvedShareExcludingExternal: number }
interface Corpus { readonly corpus: string; readonly languages: readonly LanguageRow[]; readonly total: LanguageRow }

const reference = readFileSync(new URL("../docs/reference.md", import.meta.url), "utf8");
const citation = reference.match(/\[`(benchmarks\/results\/resolution-coverage-[^`]+\.json)`\]/)?.[1];

function rowsFromRecord(): string[] {
  const record = JSON.parse(readFileSync(new URL(`../${citation}`, import.meta.url), "utf8")) as { corpora: Corpus[] };
  const percent = (share: number): string => `${(share * 100).toFixed(1)}%`;
  const row = (corpus: string, item: LanguageRow, language: string): string =>
    `| ${corpus} | ${language} | ${item.calls} | ${item.resolved} | ${percent(item.resolvedShare)} | ${percent(item.resolvedShareExcludingExternal)} |`;
  return record.corpora.flatMap((corpus) => {
    const name = corpus.corpus.replace(/-v\d+$/, "");
    return [
      ...corpus.languages.filter((item) => item.calls > 0).map((item) => row(name, item, item.language)),
      row(name, corpus.total, "all"),
    ];
  });
}

function rowsFromReference(): string[] {
  const start = reference.indexOf("Resolved share per corpus and language on the pinned checkouts");
  expect(start).toBeGreaterThan(0);
  const lines = reference.slice(start).split("\n");
  const first = lines.findIndex((line) => line.startsWith("| click |") || line.startsWith("| cobra |"));
  const rows: string[] = [];
  for (const line of lines.slice(first)) {
    if (!line.startsWith("|")) break;
    rows.push(line.trim());
  }
  return rows;
}

it("names the record the table is generated from", () => {
  expect(citation).toBeDefined();
});

it("prints exactly the rows of the record it cites", () => {
  expect(rowsFromReference()).toEqual(rowsFromRecord());
});
