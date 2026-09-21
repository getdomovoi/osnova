import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index.js";

let temporary: string;
let workspace: string;
let cacheDir: string;

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-merged-local-"));
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

describe("a name carrying a merged declaration and an inferred value", () => {
  it("binds a construction to the declaration the source states", async () => {
    const index = await build({
      "schemas.ts": [
        "export function make<T>(name: string): { new (def: T): T } {",
        "  return class { constructor(public def: T) {} } as never;",
        "}",
        "",
        "export interface Box { size: number; }",
        "export const Box: ReturnType<typeof make<Box>> = make<Box>(\"Box\");",
        "",
        "export function box(size: number): Box {",
        "  return new Box({ size });",
        "}",
        "",
      ].join("\n"),
    });

    expect(callEdge(index, "schemas.ts#box", "schemas.ts#Box")).toBeDefined();
  });

  it("binds a construction when the value is declared before the type", async () => {
    const index = await build({
      "shapes.ts": [
        "export function make<T>(name: string): { new (def: T): T } {",
        "  return class { constructor(public def: T) {} } as never;",
        "}",
        "",
        "export const Ring: ReturnType<typeof make<Ring>> = make<Ring>(\"Ring\");",
        "export interface Ring { radius: number; }",
        "",
        "export function ring(radius: number): Ring {",
        "  return new Ring({ radius });",
        "}",
        "",
      ].join("\n"),
    });

    expect(callEdge(index, "shapes.ts#ring", "shapes.ts#Ring")).toBeDefined();
  });

  it("leaves a name unresolved when no declaration states it", async () => {
    const index = await build({
      "factory.ts": [
        "export function first(): { run: () => number } { return { run: () => 1 }; }",
        "export function second(): { run: () => number } { return { run: () => 2 }; }",
        "",
        "export function pick(flag: boolean): number {",
        "  let handle = first();",
        "  if (flag) handle = second();",
        "  return handle.run();",
        "}",
        "",
      ].join("\n"),
    });

    const memberEdge = index.edges.find((edge) =>
      edge.kind === "calls" && edge.fromSymbol === "factory.ts#pick" && edge.toName === "run");
    expect(memberEdge).toBeDefined();
    expect(memberEdge?.toSymbol).toBeUndefined();
  });
});
