import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index.js";

let temporary: string;
let workspace: string;
let cacheDir: string;

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-assertion-"));
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
  index.edges.find((edge) => edge.kind === "calls" && edge.fromSymbol === from && edge.toSymbol === to);

describe("callees written behind a type assertion", () => {
  it("resolves a call whose callee is widened with as", async () => {
    const index = await build({
      "checks.ts": ["export function regex(pattern: string): string { return pattern; }", ""].join("\n"),
      "main.ts": [
        "import * as checks from \"./checks.js\";",
        "export function run(): unknown {",
        "  return (checks.regex as any)(\"a\");",
        "}",
        "",
      ].join("\n"),
    });

    const edge = callEdge(index, "main.ts#run", "checks.ts#regex");
    expect(edge).toBeDefined();
    expect(edge?.evidence).toMatchObject({ resolution: { status: "resolved" } });
  });

  it("resolves a call whose callee is a satisfies expression", async () => {
    const index = await build({
      "checks.ts": ["export function minLength(value: number): number { return value; }", ""].join("\n"),
      "main.ts": [
        "import { minLength } from \"./checks.js\";",
        "export function run(): unknown {",
        "  return (minLength satisfies (value: number) => number)(1);",
        "}",
        "",
      ].join("\n"),
    });

    const edge = callEdge(index, "main.ts#run", "checks.ts#minLength");
    expect(edge).toBeDefined();
    expect(edge?.evidence).toMatchObject({ resolution: { status: "resolved" } });
  });

  it("leaves a receiver unresolved when a cast chain changes its type", async () => {
    const index = await build({
      "shapes.ts": [
        "export class Box {",
        "  open(): number { return 1; }",
        "}",
        "",
      ].join("\n"),
      "main.ts": [
        "import { Box } from \"./shapes.js\";",
        "export function run(box: Box): unknown {",
        "  const loose = (box as unknown as { open: () => number });",
        "  return loose.open();",
        "}",
        "",
      ].join("\n"),
    });

    expect(callEdge(index, "main.ts#run", "shapes.ts#Box.open")).toBeUndefined();
  });

  it("resolves a receiver written behind a type assertion", async () => {
    const index = await build({
      "shapes.ts": [
        "export class Box {",
        "  open(): number { return 1; }",
        "}",
        "",
      ].join("\n"),
      "main.ts": [
        "import { Box } from \"./shapes.js\";",
        "export function run(box: Box): unknown {",
        "  return (box as Box).open();",
        "}",
        "",
      ].join("\n"),
    });

    const edge = callEdge(index, "main.ts#run", "shapes.ts#Box.open");
    expect(edge).toBeDefined();
    expect(edge?.evidence).toMatchObject({ resolution: { status: "resolved" } });
  });
});
