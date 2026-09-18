import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index.js";

let temporary: string;
beforeEach(async () => { temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-super-")); });
afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }); });
async function build(files: Record<string, string>) {
  const root = path.join(temporary, "ws"); await fs.mkdir(root);
  for (const [name, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), text); }
  return buildIndex(root, { cacheDir: path.join(temporary, "cache") });
}
const hit = (index: Awaited<ReturnType<typeof build>>, symbol: string, name = "hit") => index.outgoing(symbol).find((edge) => edge.toName === name)?.toSymbol;

describe("super receivers", () => {
  it("resolves super calls to the single declared base in TypeScript, Python, Java and C#", async () => {
    const index = await build({
      "base.ts": "export class Base { hit() {} }\n",
      "a.ts": "import { Base } from './base.js';\nexport class Child extends Base {\n  hit() { super.hit(); }\n  other() { super.missing(); }\n}\nclass Orphan { run() { super.hit(); } }\n",
      "b.py": "class Base:\n    def hit(self):\n        pass\n\nclass Other:\n    def hit(self):\n        pass\n\nclass Child(Base):\n    def hit(self):\n        super().hit()\n\nclass Multi(Base, Other):\n    def hit(self):\n        super().hit()\n\ndef super():\n    return None\n",
      "c.py": "from b import Base\n\nclass Child(Base):\n    def hit(self):\n        super().hit()\n",
      "J.java": "class Base { void hit() {} }\nclass Child extends Base { void hit() { super.hit(); } }\n",
      "C.cs": "class Base { public virtual void Hit() {} }\nclass Child : Base { public override void Hit() { base.Hit(); } }\n",
    });
    expect(hit(index, "a.ts#Child.hit")).toBe("base.ts#Base.hit");
    expect(hit(index, "a.ts#Child.other", "missing")).toBeUndefined();
    expect(hit(index, "a.ts#Orphan.run")).toBeUndefined();
    expect(hit(index, "b.py#Child.hit")).toBeUndefined();
    expect(hit(index, "c.py#Child.hit")).toBe("b.py#Base.hit");
    expect(hit(index, "b.py#Multi.hit")).toBeUndefined();
    expect(hit(index, "J.java#Child.hit")).toBe("J.java#Base.hit");
    expect(hit(index, "C.cs#Child.Hit", "Hit")).toBe("C.cs#Base.Hit");
  });
});
