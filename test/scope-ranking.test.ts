import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index/build.js";
import { scopedAsk, detectScopes } from "../src/query/scoped.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

async function monorepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-scopes-")); dirs.push(dir);
  await fs.writeFile(path.join(dir, "package.json"), '{"name":"root","workspaces":["packages/*"]}');
  for (const [name, body] of [["core", "export function retryTimer(): number { return 1; }\nexport function retryBackoff(): number { return 2; }\n"], ["ui", "export function overlayWidget(): number { return 3; }\n"], ["docs", "export const retry = 'retry retry retry retry';\n"]] as const) {
    await fs.mkdir(path.join(dir, "packages", name, "src"), { recursive: true });
    await fs.writeFile(path.join(dir, "packages", name, "src", "index.ts"), body);
  }
  await fs.writeFile(path.join(dir, "packages", "core", "package.json"), '{"name":"@x/core"}');
  return dir;
}

describe("scope ranking", () => {
  it("discovers workspace globs as scopes even without a manifest", async () => {
    const dir = await monorepo();
    const scopes = detectScopes(await buildIndex(dir)).map((s) => s.path);
    expect(scopes).toEqual(["", "packages/core", "packages/docs", "packages/ui"]);
  });

  it("merges hits round-robin by scope path order", async () => {
    const index = await buildIndex(await monorepo());
    const result = scopedAsk(index, "retry timer", { limit: 4 });
    expect(result.hits.map((h) => h.scope)).toEqual(["packages/core", "packages/docs", "packages/core"]);
    expect(result.alsoMatched).toEqual([]);
    expect(result.limitations).toContain("scope-round-robin-path-order");
    expect(result.limitations).not.toContain("scope-participation-threshold-0.25");
  });
});
