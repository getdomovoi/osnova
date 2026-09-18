import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index.js";

let temporary: string;
beforeEach(async () => { temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-generic-")); });
afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }); });
async function build(files: Record<string, string>) {
  const root = path.join(temporary, "ws"); await fs.mkdir(root);
  for (const [name, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), text); }
  return buildIndex(root, { cacheDir: path.join(temporary, "cache") });
}
const edge = (index: Awaited<ReturnType<typeof build>>, symbol: string, name: string) => {
  const found = index.outgoing(symbol).find((item) => item.toName === name);
  const resolution = found?.evidence?.source === "syntax" ? found.evidence.resolution : undefined;
  return resolution?.status === "unresolved" ? resolution.reason : found?.toSymbol;
};

describe("generic base types as receivers", () => {
  it("binds the base of a generic instantiation and classifies builtin generics as external", async () => {
    const index = await build({
      "a.ts": "class Foo { hit() {} }\nclass Wrapper<T> { unwrap(): T { return null as any; } peek() {} }\nfunction use(w: Wrapper<Foo>, m: Map<string, Foo>, list: Foo[], p: Promise<Foo>) {\n  w.peek();\n  m.get('x');\n  list.push(null as any);\n  p.then(() => {});\n  w.unwrap().hit();\n}\n",
      "b.py": "class Foo:\n    def hit(self):\n        pass\n\nclass Wrapper:\n    def peek(self):\n        pass\n\ndef use(w: Wrapper[Foo], items: list[Foo], o: dict[str, Foo]):\n    w.peek()\n    items.append(1)\n    o.get('x')\n",
      "go.mod": "module example.com/g\n",
      "g.go": "package g\n\ntype Wrapper[T any] struct{}\n\nfunc (w *Wrapper[T]) Peek() {}\n\nfunc use(w *Wrapper[int], m map[string]int) { w.Peek(); }\n",
      "Cargo.toml": "[package]\nname = 'r'\n",
      "src/lib.rs": "pub struct Wrapper<T>(T);\nimpl<T> Wrapper<T> { pub fn peek(&self) {} }\npub fn use_it(w: &Wrapper<u8>, v: Vec<u8>, o: Option<u8>) { w.peek(); v.push(1); o.unwrap(); }\n",
      "J.java": "import java.util.List;\nclass Wrapper<T> { void peek() {} }\nclass App { void use(Wrapper<String> w, List<String> list) { w.peek(); list.size(); } }\n",
      "C.cs": "class Wrapper<T> { public void Peek() {} }\nclass App { void Use(Wrapper<string> w, System.Collections.Generic.List<string> list) { w.Peek(); list.Add(\"x\"); } }\n",
    });
    expect(edge(index, "a.ts#use", "peek")).toBe("a.ts#Wrapper.peek");
    expect(edge(index, "a.ts#use", "get")).toBe("unbound-global");
    expect(edge(index, "a.ts#use", "push")).toBe("unbound-global");
    expect(edge(index, "a.ts#use", "then")).toBe("unbound-global");
    expect(edge(index, "a.ts#use", "hit")).toBe("receiver-unresolved");
    expect(edge(index, "b.py#use", "peek")).toBe("b.py#Wrapper.peek");
    expect(edge(index, "b.py#use", "append")).toBe("unbound-global");
    expect(edge(index, "b.py#use", "get")).toBe("unbound-global");
    expect(edge(index, "g.go#use", "Peek")).toBe("g.go#Wrapper.Peek");
    expect(edge(index, "src/lib.rs#use_it", "peek")).toBe("src/lib.rs#Wrapper.peek");
    expect(edge(index, "src/lib.rs#use_it", "push")).toBe("unbound-global");
    expect(edge(index, "src/lib.rs#use_it", "unwrap")).toBe("unbound-global");
    expect(edge(index, "J.java#App.use", "peek")).toBe("J.java#Wrapper.peek");
    expect(edge(index, "J.java#App.use", "size")).toBe("import-target-unresolved");
    expect(edge(index, "C.cs#App.Use", "Peek")).toBe("C.cs#Wrapper.Peek");
  });
});
