import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index.js";
import type { OsnovaEdge } from "../src/types.js";

let temporary: string;
let workspace: string;
let cacheDir: string;

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-shadowed-"));
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

const callsTo = (edges: readonly OsnovaEdge[], name: string): OsnovaEdge[] =>
  edges.filter((edge) => edge.kind === "calls" && edge.toName === name);

describe("shadowed same-file locals", () => {
  it("refuses a call to a name the file declares in two scopes", async () => {
    const index = await build({
      "a.ts": [
        "function test(name: string, fn: () => void): void { fn(); }",
        "",
        'test("one", () => {',
        "  const helper = (): number => 1;",
        "  helper();",
        "});",
        "",
        'test("two", () => {',
        "  const helper = (): number => 2;",
        "  helper();",
        "});",
        "",
      ].join("\n"),
    });
    const calls = callsTo(index.edges, "helper");
    expect(calls).toHaveLength(2);
    for (const edge of calls) {
      expect(edge.toSymbol).toBeUndefined();
      expect(edge.evidence).toEqual({ source: "syntax", resolution: { status: "unresolved", reason: "shadowed-declaration" } });
    }
    expect(index.files.get("a.ts")?.symbols.filter((symbol) => symbol.name === "helper").every((symbol) => symbol.shadowed === true)).toBe(true);
  });

  it("keeps a value and a type of the same name in one scope resolved", async () => {
    const index = await build({
      "a.ts": [
        "export interface Shape { size: number }",
        "export const Shape = (): number => 1;",
        "export function use(): number { return Shape(); }",
        "",
      ].join("\n"),
    });
    const calls = callsTo(index.edges, "Shape");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.evidence).toEqual({ source: "syntax", resolution: { status: "resolved", method: "lexical-definition" } });
    expect(index.files.get("a.ts")?.symbols.some((symbol) => symbol.shadowed === true)).toBe(false);
  });

  it("keeps python overload stubs and conditional definitions resolved", async () => {
    const index = await build({
      "a.py": [
        "import typing as t",
        "",
        "@t.overload",
        "def build(value: int) -> int: ...",
        "",
        "@t.overload",
        "def build(value: str) -> str: ...",
        "",
        "def build(value):",
        "    return value",
        "",
        "def outer(flag):",
        "    if flag:",
        "        def inner():",
        "            return 1",
        "    else:",
        "        def inner():",
        "            return 2",
        "    return inner()",
        "",
        "def use():",
        "    return build(1)",
        "",
      ].join("\n"),
    });
    const built = callsTo(index.edges, "build");
    expect(built).toHaveLength(1);
    expect(built[0]?.evidence).toEqual({ source: "syntax", resolution: { status: "resolved", method: "lexical-definition" } });
    const inner = callsTo(index.edges, "inner");
    expect(inner).toHaveLength(1);
    expect(inner[0]?.evidence).toEqual({ source: "syntax", resolution: { status: "resolved", method: "lexical-definition" } });
    expect(index.files.get("a.py")?.symbols.some((symbol) => symbol.shadowed === true)).toBe(false);
  });
});
