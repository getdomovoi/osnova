import { expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Every record under benchmarks/results/ is provenance for a published claim, or it is superseded
// and listed as such. Nine records once sat beside the cited ones with no citation, one of them
// a same-date twin of the record the README stakes its numbers on.
const root = fileURLToPath(new URL("..", import.meta.url));
const results = path.join(root, "benchmarks", "results");
const skipDirs = new Set(["node_modules", "dist", ".git", ".claude", "results"]);
const textExtensions = new Set([".md", ".ts", ".mjs", ".js", ".json", ".yml", ".yaml", ".sh", ".py"]);

function trackedText(): string {
  const parts: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (!skipDirs.has(entry)) walk(full);
      } else if (textExtensions.has(path.extname(entry))) {
        parts.push(readFileSync(full, "utf8"));
      }
    }
  };
  walk(root);
  return parts.join("\n");
}

const corpus = trackedText();
const index = readFileSync(path.join(results, "README.md"), "utf8");
const jsonIn = (dir: string): string[] => readdirSync(dir).filter((name) => name.endsWith(".json")).sort();

it("cites every current record from a tracked document, test or script", () => {
  const uncited = jsonIn(results).filter((name) => !corpus.includes(name));
  expect(uncited).toEqual([]);
});

it("lists every superseded record in the index with what replaced it", () => {
  const unlisted = jsonIn(path.join(results, "superseded")).filter((name) => !index.includes(name));
  expect(unlisted).toEqual([]);
});

it("keeps the index itself current", () => {
  const stale = [...index.matchAll(/`([a-z0-9-]+\.json)`/g)].map((match) => match[1]!)
    .filter((name) => !jsonIn(results).includes(name) && !jsonIn(path.join(results, "superseded")).includes(name));
  expect(stale).toEqual([]);
});
