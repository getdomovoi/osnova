import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex, loadIndex } from "../src/index.js";
describe("deep receiver chains", () => {
  it("stores a bounded owner chain that a fresh process can validate and load", async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-deep-chain-"));
    try {
      const root = path.join(temporary, "ws"); await fs.mkdir(root);
      const hops = "abcdefghijklmnop".split("");
      const classes = ["class Z { hit() {} }", ...hops.map((name, index) => `class ${name.toUpperCase()} { z: Z = new Z(); ${index + 1 < hops.length ? `${hops[index + 1]}: ${hops[index + 1]!.toUpperCase()} = new ${hops[index + 1]!.toUpperCase()}();` : "hit() {}"} }`)].join("\n");
      const chain = hops.slice(1).join(".");
      await fs.writeFile(path.join(root, "a.ts"), `${classes}\nexport function use(a: A) {\n  a.${chain}.hit();\n  a.b.c.d.z.hit();\n}\n`);
      const cacheDir = path.join(temporary, "cache");
      const built = await buildIndex(root, { cacheDir });
      const deep = [...built.outgoing("a.ts#use")].filter((edge) => edge.toName === "hit");
      expect(deep).toHaveLength(2);
      expect(deep[0]?.binding?.kind).toBe("blocked");
      expect(deep[1]?.binding).toMatchObject({ kind: "member", owner: { kind: "field", member: "z" } });
      const loaded = await loadIndex(root, { cacheDir });
      expect(loaded).toBeDefined();
      expect([...loaded!.edges].filter((edge) => edge.toName === "hit")).toHaveLength(2);
      expect([...loaded!.outgoing("a.ts#use")].filter((edge) => edge.toName === "hit")[1]?.toSymbol).toBe("a.ts#Z.hit");
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  });
});
