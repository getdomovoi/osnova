import { afterAll, beforeAll, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex, applyChanges, serializeArtifact } from "../src/index.js";

let temporary: string;
let workspace: string;
let cacheDir: string;

beforeAll(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-nested-definitions-"));
  workspace = path.join(temporary, "workspace");
  cacheDir = path.join(temporary, "cache");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "nested.ts"), "export const outer = () => {\n  function inner() { return 1; }\n  const nestedArrow = () => inner();\n  const marker = 7;\n  return nestedArrow();\n};\nexport function declared() {\n  function helper() { return 2; }\n  return helper();\n}\n");
});

afterAll(async () => { await fs.rm(temporary, { recursive: true, force: true }); });

it("retains nested declarations under arrow and declared functions", async () => {
  const index = await buildIndex(workspace, { cacheDir });
  expect([...index.symbols.keys()]).toEqual([
    "nested.ts#outer", "nested.ts#outer.inner", "nested.ts#outer.nestedArrow", "nested.ts#outer.marker",
    "nested.ts#declared", "nested.ts#declared.helper",
  ]);
  expect(index.outgoing("nested.ts#outer.nestedArrow")[0]?.toSymbol).toBe("nested.ts#outer.inner");
  expect(index.outgoing("nested.ts#outer")[0]?.toSymbol).toBe("nested.ts#outer.nestedArrow");
  expect(index.outgoing("nested.ts#declared")[0]?.toSymbol).toBe("nested.ts#declared.helper");
});

it("retains incremental/full equality when nested definitions change", async () => {
  const index = await buildIndex(workspace, { cacheDir });
  const source = await fs.readFile(path.join(workspace, "nested.ts"), "utf8");
  await fs.writeFile(path.join(workspace, "nested.ts"), source.replaceAll("inner", "renamed"));
  try {
    const updated = await applyChanges(index, workspace, ["nested.ts"]);
    expect(updated.symbols.has("nested.ts#outer.renamed")).toBe(true);
    expect(serializeArtifact(updated)).toEqual(serializeArtifact(await buildIndex(workspace, { cacheDir })));
  } finally {
    await fs.writeFile(path.join(workspace, "nested.ts"), source);
  }
});
