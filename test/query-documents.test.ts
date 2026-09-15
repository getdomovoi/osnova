import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index/build.js";
import { applyChanges, freshness } from "../src/index/incremental.js";
import { queryContext } from "../src/query/context.js";
import { ask } from "../src/query/ask.js";
import { scopedAsk } from "../src/query/scoped.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

describe("query documents", () => {
  it("reuses unchanged files' documents across a refresh", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-docs-")); dirs.push(dir);
    await fs.cp(path.join(import.meta.dirname, "fixtures", "sample-repo"), dir, { recursive: true });
    const before = await buildIndex(dir);
    const docsBefore = queryContext(before).documents.filter((d) => d.file === "src/app.ts");
    await fs.appendFile(path.join(dir, "src", "util.ts"), "\nexport function added(): number { return 1; }\n");
    const report = await freshness(before, dir);
    const after = await applyChanges(before, dir, report.changed);
    const ctx = queryContext(after);
    const docsAfter = ctx.documents.filter((d) => d.file === "src/app.ts");
    expect(docsAfter.length).toBe(docsBefore.length);
    docsAfter.forEach((d, i) => expect(d).toBe(docsBefore[i]));
    expect(ctx.documents.filter((d) => d.file === "src/util.ts").some((d) => d.symbol?.name === "added")).toBe(true);
    expect(ask(after, "added", { limit: 3 }).hits[0]?.symbol?.name).toBe("added");
  });

  it("scores scopedAsk on the shared documents", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-docs-")); dirs.push(dir);
    await fs.mkdir(path.join(dir, "packages", "a", "src"), { recursive: true });
    await fs.mkdir(path.join(dir, "packages", "b", "src"), { recursive: true });
    await fs.writeFile(path.join(dir, "packages", "a", "package.json"), '{"name":"@x/a"}');
    await fs.writeFile(path.join(dir, "packages", "b", "package.json"), '{"name":"@x/b"}');
    await fs.writeFile(path.join(dir, "packages", "a", "src", "retry.ts"), "export function retryTimer(): number { return 1; }\n");
    await fs.writeFile(path.join(dir, "packages", "b", "src", "other.ts"), "export function unrelated(): number { return 2; }\n");
    const index = await buildIndex(dir);
    const shared = queryContext(index);
    const result = scopedAsk(index, "retry timer", { limit: 4 });
    expect(result.hits[0]?.scope).toBe("packages/a");
    expect(queryContext(index)).toBe(shared);
    expect(result.limitations).toContain("repository-wide-idf");
  });
});
