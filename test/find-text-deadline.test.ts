import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index/build.js";
import { findTextDetailed } from "../src/query/findText.js";
import type { OsnovaIndex } from "../src/types.js";

const FILES = 8;
const LINE = 900_000;

let temporary: string;
let wide: OsnovaIndex;

beforeAll(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-find-text-deadline-"));
  const workspace = path.join(temporary, "workspace");
  await fs.mkdir(workspace);
  // Minified-bundle-shaped lines just under maximumIndexedFileSizeBytes, so they are actually indexed.
  // A quantifier-free pattern is cheap per start position and still has millions of start positions here.
  for (let i = 0; i < FILES; i += 1) {
    await fs.writeFile(path.join(workspace, `bundle${i}.ts`), `// ${"a".repeat(LINE)}\nexport const x${i} = 1;\n`);
  }
  wide = await buildIndex(workspace);
  // Guard the apparatus: against an empty index every deadline assertion below would pass for free.
  expect(wide.files.size).toBe(FILES);
  expect(findTextDetailed(wide, "export", { budgetMs: 5_000 }).totalMatches).toBe(FILES);
});

afterAll(async () => {
  await fs.rm(temporary, { recursive: true, force: true });
});

describe("findTextDetailed deadline", () => {
  // Before the fix this pattern took the inline path, which carried no deadline at all: it ran to
  // completion in roughly 350 ms over these files while reporting a 1 ms budget, and grew with the index.
  it("applies the budget to a quantifier-free pattern over a very long line", () => {
    const started = performance.now();
    expect(() => findTextDetailed(wide, "[a-z]", { budgetMs: 1 })).toThrow(/pattern-budget-exceeded/);
    expect(performance.now() - started).toBeLessThan(150);
  });

  it("applies the budget to a literal pattern over a very long line", () => {
    const started = performance.now();
    expect(() => findTextDetailed(wide, "a", { budgetMs: 1 })).toThrow(/pattern-budget-exceeded/);
    expect(performance.now() - started).toBeLessThan(150);
  });

  it("does not refuse work that fits: a cheap pattern answers under the same 1 ms budget", () => {
    expect(findTextDetailed(wide, "export", { budgetMs: 1 }).totalMatches).toBe(FILES);
    expect(findTextDetailed(wide, "zzz-not-present", { budgetMs: 1 }).totalMatches).toBe(0);
  });

  it("answers the same heavy pattern when the budget is large enough", () => {
    // Per file: the long comment line, plus the 12 lowercase letters of "export const xN = 1;".
    const result = findTextDetailed(wide, "[a-z]", { budgetMs: 30_000 });
    expect(result.totalMatches).toBe(FILES * (LINE + 12));
  });

  it("keeps counting exactly once the scan completes", () => {
    const result = findTextDetailed(wide, "export", { budgetMs: 30_000 });
    expect(result.omittedMatches).toBe(0);
    expect(result.truncated).toBe(false);
  });
});
