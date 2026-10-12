import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanFiles, scanWorkspace, witnessHolds } from "../src/index/scan.js";

const temporaries: string[] = [];
afterEach(async () => { for (const dir of temporaries.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

async function fixture(): Promise<{ temporary: string; root: string; link: string }> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-witness-"));
  temporaries.push(temporary);
  const root = path.join(temporary, "ws");
  const other = path.join(temporary, "other");
  for (const dir of [path.join(root, "src", "deep"), path.join(root, "ignored"), path.join(root, "node_modules", "dep"), path.join(temporary, "target"), other]) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
  await fs.writeFile(path.join(root, "src", "deep", "b.ts"), "export const b = 2;\n");
  await fs.writeFile(path.join(root, "ignored", "c.ts"), "export const c = 3;\n");
  await fs.writeFile(path.join(root, ".osnovaignore"), "ignored/\n");
  await fs.writeFile(path.join(other, "z.ts"), "export const z = 0;\n");
  await fs.symlink(path.join(temporary, "target"), path.join(root, "linked"));
  const link = path.join(temporary, "root-link");
  await fs.symlink(root, link);
  return { temporary, root, link };
}

describe("scan witness", () => {
  it("holds while the tree is unchanged, including after reads and changes in skipped or ignored places", async () => {
    const { root, link } = await fixture();
    const { scan, witness } = await scanWorkspace(link);
    await fs.readFile(path.join(root, "a.ts"));
    await fs.writeFile(path.join(root, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    await fs.writeFile(path.join(root, "ignored", "c.ts"), "export const c = 4;\n");
    expect(await witnessHolds(link, witness)).toBe(true);
    expect(await scanFiles(link)).toEqual(scan);
  });

  const changes: ReadonlyArray<readonly [string, (f: { temporary: string; root: string; link: string }) => Promise<void>]> = [
    ["an in-place edit of the same size", async ({ root }) => { await fs.writeFile(path.join(root, "a.ts"), "export const a = 9;\n"); }],
    ["a file added in a nested directory", async ({ root }) => { await fs.writeFile(path.join(root, "src", "deep", "d.ts"), "export const d = 4;\n"); }],
    ["a deleted file", async ({ root }) => { await fs.rm(path.join(root, "src", "deep", "b.ts")); }],
    ["a renamed file", async ({ root }) => { await fs.rename(path.join(root, "a.ts"), path.join(root, "e.ts")); }],
    ["an in-place edit of an ignore file", async ({ root }) => { await fs.writeFile(path.join(root, ".osnovaignore"), "nothing/\n"); }],
    ["a symlink target that stops being a directory", async ({ temporary }) => { await fs.rm(path.join(temporary, "target"), { recursive: true }); await fs.writeFile(path.join(temporary, "target"), "file\n"); }],
    ["a retargeted workspace root", async ({ temporary, link }) => { await fs.rm(link); await fs.symlink(path.join(temporary, "other"), link); }],
  ];

  for (const [name, change] of changes) {
    it(`stops holding after ${name}`, async () => {
      const f = await fixture();
      const { witness } = await scanWorkspace(f.link);
      expect(await witnessHolds(f.link, witness)).toBe(true);
      await change(f);
      expect(await witnessHolds(f.link, witness)).toBe(false);
    });
  }
});
