import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = path.resolve(import.meta.dirname, "..");
const script = pathToFileURL(path.join(repo, "scripts/check-package.mjs")).href;
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

async function fakeGrammarRoot(change: (out: string) => Promise<void>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-grammar-digest-"));
  dirs.push(root);
  const real = path.join(repo, "node_modules/tree-sitter-wasms");
  const out = path.join(root, "node_modules/tree-sitter-wasms/out");
  await fs.mkdir(out, { recursive: true });
  await fs.copyFile(path.join(real, "package.json"), path.join(root, "node_modules/tree-sitter-wasms/package.json"));
  for (const name of await fs.readdir(path.join(real, "out"))) await fs.symlink(path.join(real, "out", name), path.join(out, name));
  await change(out);
  return root;
}

describe("supply-chain checks in scripts/check-package.mjs", () => {
  it("accepts the installed grammar blobs", async () => {
    const { checkGrammarDigests } = await import(script);
    await expect(checkGrammarDigests(repo)).resolves.toBe(36);
  });

  it("rejects a grammar blob whose bytes changed", async () => {
    const { checkGrammarDigests } = await import(script);
    const root = await fakeGrammarRoot(async (out) => {
      await fs.rm(path.join(out, "tree-sitter-bash.wasm"));
      await fs.writeFile(path.join(out, "tree-sitter-bash.wasm"), "\0asm tampered");
    });
    await expect(checkGrammarDigests(root)).rejects.toThrow(/tree-sitter-bash\.wasm/);
  });

  it("rejects a grammar blob that was added or removed", async () => {
    const { checkGrammarDigests } = await import(script);
    const added = await fakeGrammarRoot(async (out) => { await fs.writeFile(path.join(out, "tree-sitter-extra.wasm"), "\0asm"); });
    await expect(checkGrammarDigests(added)).rejects.toThrow(/tree-sitter-extra\.wasm/);
    const removed = await fakeGrammarRoot(async (out) => { await fs.rm(path.join(out, "tree-sitter-go.wasm")); });
    await expect(checkGrammarDigests(removed)).rejects.toThrow(/tree-sitter-go\.wasm/);
  });

  it("counts the installed runtime dependency tree and enforces a ceiling", async () => {
    const { checkRuntimeTree, runtimePackages } = await import(script);
    const packages: string[] = await runtimePackages(repo);
    expect(packages).toContain("ignore@7.0.9");
    expect(packages.some((name) => name.startsWith("@modelcontextprotocol/sdk@"))).toBe(true);
    expect(packages.some((name) => name.startsWith("vitest@"))).toBe(false);
    await expect(checkRuntimeTree(repo)).resolves.toBe(packages.length);
    await expect(checkRuntimeTree(repo, packages.length - 1)).rejects.toThrow(/runtime dependency tree/);
  });
});
