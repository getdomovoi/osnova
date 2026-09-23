import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

// The reference's CLI block is what the README calls "the full list". It had fourteen of the
// eighteen subcommands, and the four it lacked included the one command the privacy policy is
// built around disclosing.
// A Windows checkout may carry CRLF, and both the heading search and the `$` anchors below assume LF.
const lf = (url: URL): string => readFileSync(url, "utf8").replace(/\r\n/g, "\n");
const usage = lf(new URL("../src/cli/cli.ts", import.meta.url));
const reference = lf(new URL("../docs/reference.md", import.meta.url));

function usageSubcommands(): string[] {
  const start = usage.indexOf("usage:");
  const end = usage.indexOf("`", start);
  const names = new Set<string>();
  // A subcommand starts with a letter; `osnova --version` is a flag, not a subcommand.
  for (const match of usage.slice(start, end).matchAll(/^ {2}osnova ([a-z][a-z-]*)/gm)) names.add(match[1]!);
  return [...names].sort();
}

function referenceCliBlock(): string {
  const heading = reference.indexOf("\n## CLI\n");
  const open = reference.indexOf("```sh", heading);
  const close = reference.indexOf("```", open + 5);
  return reference.slice(open, close);
}

it("documents every CLI subcommand the binary accepts", () => {
  const names = usageSubcommands();
  expect(names.length).toBeGreaterThanOrEqual(18);
  const block = referenceCliBlock();
  const missing = names.filter((name) => !new RegExp(`^osnova ${name}( |$)`, "m").test(block));
  expect(missing).toEqual([]);
});

it("documents the hook events the binary accepts", () => {
  const events = usage.match(/osnova hook <([a-z|-]+)>/)?.[1];
  expect(events).toBeDefined();
  expect(referenceCliBlock()).toContain(`osnova hook <${events}>`);
});
