import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index.js";

let temporary: string;
beforeEach(async () => { temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-namespaces-")); });
afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }); });
async function build(files: Record<string, string>) {
  const root = path.join(temporary, "ws"); await fs.mkdir(root);
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(root, name), text);
  return buildIndex(root, { cacheDir: path.join(temporary, "cache") });
}
const targets = (index: Awaited<ReturnType<typeof build>>, symbol: string) =>
  [...index.outgoing(symbol).filter((edge) => edge.kind === "calls")].sort((a, b) => a.line - b.line || a.toName.localeCompare(b.toName)).map((edge) => [edge.toName, edge.toSymbol]);

describe("TypeScript namespaces", () => {
  it("indexes namespace members under the namespace and resolves calls through the namespace name", async () => {
    const index = await build({
      "uri.ts": "export interface Uri { hit(): void; }\nexport namespace Uri {\n  export function create(): Uri { return {} as Uri; }\n  export function twice(): Uri {\n    return create();\n  }\n  export namespace Inner {\n    export function f() {}\n  }\n}\nexport class ClassType { flag(): boolean { return true; } }\nexport namespace ClassType {\n  export function isFlagged(t: ClassType): boolean {\n    return t.flag();\n  }\n}\n",
      "a.ts": "import { Uri, ClassType } from './uri.js';\nexport function use(u: Uri, c: ClassType) {\n  Uri.create().hit();\n  Uri.Inner.f();\n  ClassType.isFlagged(c);\n  c.flag();\n  u.create();\n  c.isFlagged(c);\n}\n",
      "b.ts": "namespace Outer { export namespace Inner { export function f() {} } export class K { static make(): K { return new K(); } hit() {} } }\nfunction local() {\n  Outer.Inner.f();\n  Outer.K.make().hit();\n  Outer.K.missing.f();\n}\n",
    });
    expect((index.files.get("uri.ts")?.symbols ?? []).filter((symbol) => symbol.name === "Uri").map((symbol) => symbol.kind).sort()).toEqual(["interface", "module"]);
    expect(index.symbols.get("uri.ts#Uri.create")?.kind).toBe("function");
    expect(index.symbols.get("uri.ts#Uri.Inner.f")?.kind).toBe("function");
    expect(index.symbols.get("uri.ts#Uri")?.exportedNames).toEqual(["Uri"]);
    expect(targets(index, "uri.ts#Uri.twice")).toEqual([["create", "uri.ts#Uri.create"]]);
    expect(targets(index, "uri.ts#ClassType.isFlagged")).toEqual([["flag", "uri.ts#ClassType.flag"]]);
    expect(targets(index, "a.ts#use")).toEqual([
      ["create", "uri.ts#Uri.create"], ["hit", "uri.ts#Uri.hit"], ["f", undefined], ["isFlagged", "uri.ts#ClassType.isFlagged"],
      ["flag", "uri.ts#ClassType.flag"], ["create", undefined], ["isFlagged", undefined],
    ]);
    expect(targets(index, "b.ts#local")).toEqual([["f", "b.ts#Outer.Inner.f"], ["hit", "b.ts#Outer.K.hit"], ["make", "b.ts#Outer.K.make"], ["f", undefined]]);
  });

  it("skips string-named and dotted module declarations", async () => {
    const index = await build({ "a.ts": "declare module 'foo' { export function g(): void; }\nnamespace A.B { export function h() {} }\nfunction use() { A.B.h(); }\n" });
    expect([...index.symbols.keys()].filter((name) => name.includes("foo") || name.includes("A.B"))).toEqual([]);
    expect(targets(index, "a.ts#use")).toEqual([["h", undefined]]);
  });
});
