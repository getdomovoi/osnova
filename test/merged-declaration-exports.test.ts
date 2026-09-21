import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index.js";

let temporary: string;
let workspace: string;
let cacheDir: string;

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-merged-"));
  workspace = path.join(temporary, "workspace");
  cacheDir = path.join(temporary, "cache");
  await fs.mkdir(workspace);
});

afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }); });

async function build(files: Record<string, string>) {
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await fs.writeFile(path.join(workspace, file), text);
  }
  return buildIndex(workspace, { cacheDir });
}

const callEdge = (index: Awaited<ReturnType<typeof build>>, from: string, to: string) =>
  index.edges.find((edge) => edge.kind === "calls" && edge.fromSymbol === from && edge.toName === to);

describe("exports that merge a type and a value under one name", () => {
  it("resolves a call to the value when a type alias shares its name", async () => {
    const index = await build({
      "util.ts": [
        "export type OK<T> = { status: \"valid\"; value: T };",
        "export const OK = <T>(value: T): OK<T> => ({ status: \"valid\", value });",
        "",
      ].join("\n"),
      "main.ts": [
        "import { OK } from \"./util.js\";",
        "export function run(): unknown {",
        "  return OK(1);",
        "}",
        "",
      ].join("\n"),
    });

    const edge = callEdge(index, "main.ts#run", "OK");
    expect(edge).toBeDefined();
    expect(edge?.toSymbol).toBe("util.ts#OK");
    expect(edge?.toFile).toBe("util.ts");
  });

  it("resolves the value when the type is declared after it", async () => {
    const index = await build({
      "util.ts": [
        "export const DIRTY = <T>(value: T): { status: string; value: T } => ({ status: \"dirty\", value });",
        "export type DIRTY<T> = { status: \"dirty\"; value: T };",
        "",
      ].join("\n"),
      "main.ts": [
        "import { DIRTY } from \"./util.js\";",
        "export function run(): unknown {",
        "  return DIRTY(1);",
        "}",
        "",
      ].join("\n"),
    });

    const edge = callEdge(index, "main.ts#run", "DIRTY");
    expect(edge?.toSymbol).toBe("util.ts#DIRTY");
  });

  it("leaves a call unresolved when the exported name is only a type", async () => {
    const index = await build({
      "util.ts": ["export type Shape = { kind: string };", ""].join("\n"),
      "main.ts": [
        "import { Shape } from \"./util.js\";",
        "export function run(): unknown {",
        "  return (Shape as unknown as () => unknown)();",
        "}",
        "",
      ].join("\n"),
    });

    const edge = callEdge(index, "main.ts#run", "Shape");
    expect(edge?.toSymbol).toBeUndefined();
  });
});
