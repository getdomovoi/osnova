import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex, callersDetailed } from "../src/index.js";
import { plumb, parseClaims } from "../src/query/plumb.js";
import { formatCallersDetailed, formatPlumb } from "../src/query/format.js";

let temporary: string;
beforeEach(async () => { temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-name-matches-")); });
afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }); });
async function build(files: Record<string, string>) {
  const root = path.join(temporary, "ws"); await fs.mkdir(root);
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(root, name), text);
  return buildIndex(root, { cacheDir: path.join(temporary, "cache") });
}

describe("same-name candidates for unresolved calls", () => {
  it("lists indexed callables that share the name, capped and in the same language family", async () => {
    const index = await build({
      "a.ts": "export class A { hit() {} }\nexport class B { hit() {} }\nexport class C { hit() {} }\nexport class D { hit() {} }\nexport class E { hit() {} }\nexport class F { hit() {} }\nexport function caller(x: unknown) { (x as any).hit(); }\n",
      "p.py": "class P:\n    def hit(self):\n        pass\n",
    });
    const result = callersDetailed(index, "a.ts#caller", { direction: "out" });
    if (result.status !== "found") throw new Error("expected found");
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.nameMatches).toEqual({ candidates: ["a.ts#A.hit", "a.ts#B.hit", "a.ts#C.hit", "a.ts#D.hit", "a.ts#E.hit"], total: 6 });
    const text = formatCallersDetailed(result);
    expect(text).toContain("candidates for hit (6, unverified): a.ts#A.hit, a.ts#B.hit, a.ts#C.hit, a.ts#D.hit, a.ts#E.hit and 1 more");
    const inbound = callersDetailed(index, "a.ts#A.hit");
    if (inbound.status !== "found") throw new Error("expected found");
    expect(inbound.unresolved[0]?.nameMatches.total).toBe(6);
  });

  it("annotates name-only plumb verdicts with the same-name count", async () => {
    const index = await build({
      "a.ts": "export class A { hit() {} }\nexport class B { hit() {} }\nexport function caller(x: unknown) {\n  (x as any).hit();\n}\n",
    });
    const result = plumb(index, "a.ts#A.hit", parseClaims(["a.ts:4"]));
    expect(result.claims[0]).toMatchObject({ verdict: "name-only", nameMatches: { candidates: ["a.ts#A.hit", "a.ts#B.hit"], total: 2 } });
    expect(formatPlumb(result)).toContain("name-only a.ts:4 -> a.ts#caller (2 same-name symbols: a.ts#A.hit, a.ts#B.hit)");
  });
});
