import { afterEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanFiles } from "../src/index/scan.js";
import { buildIndex } from "../src/index/build.js";
import { applyChanges } from "../src/index/incremental.js";
import { serializeArtifact } from "../src/index/serialize.js";
import { freshness } from "../src/index/incremental.js";

const temporary: string[] = [];
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-scan-hardening-"));
  temporary.push(dir);
  const root = path.join(dir, "root");
  const cacheDir = path.join(dir, "cache");
  await fs.mkdir(path.join(root, "nested"), { recursive: true });
  return { root, cacheDir };
}
afterEach(async () => { await Promise.all(temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

it("applies nested anchored rules, negation and local override without leaking to siblings", async () => {
  const { root } = await fixture();
  await fs.writeFile(path.join(root, ".gitignore"), "*.txt\n");
  await fs.writeFile(path.join(root, "nested/.gitignore"), "!keep.txt\n/local.ts\n");
  await fs.writeFile(path.join(root, "nested/.osnovaignore"), "!local.ts\n");
  for (const file of ["keep.txt", "local.ts", "nested/keep.txt", "nested/drop.txt", "nested/local.ts"]) {
    await fs.writeFile(path.join(root, file), "hello\n");
  }
  expect((await scanFiles(root)).paths).toEqual(["local.ts", "nested/keep.txt", "nested/local.ts"]);
});

it("reconciles eligibility changes from ignore edits and equals a full rebuild", async () => {
  const { root, cacheDir } = await fixture();
  await fs.writeFile(path.join(root, "nested/a.ts"), "export const a = 1;\n");
  const initial = await buildIndex(root, { cacheDir });
  await fs.writeFile(path.join(root, "nested/.gitignore"), "a.ts\n");
  await fs.writeFile(path.join(root, "nested/b.ts"), "export const b = 2;\n");
  const next = await applyChanges(initial, root, ["nested/.gitignore"]);
  expect(serializeArtifact(next)).toEqual(serializeArtifact(await buildIndex(root, { cacheDir })));
});

it("canonicalizes symlink roots and accepts absolute in-root changes, rejecting escape paths", async () => {
  const { root, cacheDir } = await fixture();
  const alias = `${root}-alias`;
  await fs.symlink(root, alias, "dir");
  await fs.writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
  const initial = await buildIndex(alias, { cacheDir });
  expect(initial.root).toBe(await fs.realpath(root));
  await fs.writeFile(path.join(root, "a.ts"), "export const a = 2;\n");
  const next = await applyChanges(initial, alias, [path.join(alias, "a.ts")]);
  expect(next.files.get("a.ts")?.text).toContain("2");
  await expect(applyChanges(next, root, ["../outside.ts"])).rejects.toThrow(/outside|escape/);
});

it("never follows nested source or ignore symlinks outside the workspace", async () => {
  const { root, cacheDir } = await fixture();
  const outside = path.join(path.dirname(root), "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.ts"), "export const secret = 1;\n");
  const initial = await buildIndex(root, { cacheDir });
  await fs.symlink(outside, path.join(root, "linked"), "dir");
  expect((await scanFiles(root)).paths).toEqual([]);
  await expect(applyChanges(initial, root, ["linked/secret.ts"])).rejects.toThrow(/symlink/);
  await fs.symlink(path.join(outside, "secret.ts"), path.join(root, "nested/.gitignore"));
  await expect(scanFiles(root)).rejects.toThrow(/ignore-unreadable/);
});

it("matches full rebuilds across deterministic randomized eligibility edits, renames and deletions", async () => {
  const { root, cacheDir } = await fixture();
  let index = await buildIndex(root, { cacheDir });
  let seed = 91;
  for (let turn = 0; turn < 30; turn += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const file = `nested/file${seed % 5}.ts`;
    const absolute = path.join(root, file);
    if (turn % 4 === 0) await fs.writeFile(path.join(root, "nested/.gitignore"), `file${seed % 5}.ts\n`);
    else if (turn % 4 === 1) await fs.writeFile(absolute, `export const value${turn} = ${turn};\n`);
    else if (turn % 4 === 2) await fs.rm(absolute, { force: true });
    else {
      await fs.writeFile(absolute, `export const renamed${turn} = 1;\n`);
      await fs.rename(absolute, path.join(root, `nested/renamed${turn}.ts`));
      await fs.writeFile(path.join(root, "nested/.osnovaignore"), `!file${seed % 5}.ts\n`);
    }
    index = await applyChanges(index, root, [file]);
    const full = await buildIndex(root, { cacheDir });
    expect(serializeArtifact(index).toString()).toBe(serializeArtifact(full).toString());
    expect(await freshness(index, root)).toEqual({ added: [], changed: [], deleted: [] });
  }
});
