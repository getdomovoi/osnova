import { afterEach, expect, it } from "vitest";
import { promises as fs, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { refreshWorkspace } from "../src/api.js";
import { buildIndex } from "../src/index/build.js";
import { applyChanges, freshness } from "../src/index/incremental.js";
import { indexHealth } from "../src/index/health.js";
import { serializeArtifact } from "../src/index/serialize.js";
import { resolutionCoverage } from "../src/query/coverage.js";
import { maximumIndexedFileSizeBytes } from "../src/types.js";
import type { ProgressEvent } from "../src/types.js";

const temporary: string[] = [];
async function fixture(): Promise<{ root: string; cacheDir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-oversized-"));
  temporary.push(dir);
  const root = path.join(dir, "root");
  await fs.mkdir(root);
  return { root, cacheDir: path.join(dir, "cache") };
}
afterEach(async () => { await Promise.all(temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

const tooLarge = (file: string) => ({ phase: "scan", path: file, code: "file-too-large" });
const bigSource = (head: string, extra = 0) => `${head}\n${"/".repeat(maximumIndexedFileSizeBytes + extra)}\n`;

it("records a file above the size cap as a visible skip in the index, health and coverage", async () => {
  const { root, cacheDir } = await fixture();
  await fs.writeFile(path.join(root, "small.ts"), "export function small() { return big(); }\n");
  const big = bigSource("export function big() { return 1; }", 144);
  await fs.writeFile(path.join(root, "big.ts"), big);
  const index = await buildIndex(root, { cacheDir });
  expect([...index.files.keys()]).toEqual(["big.ts", "small.ts"]);
  expect(index.diagnostics).toEqual([tooLarge("big.ts")]);
  expect(index.files.get("big.ts")).toMatchObject({ language: "fallback", size: Buffer.byteLength(big), text: "", symbols: [], hash: createHash("sha256").update(big).digest("hex") });
  expect((await indexHealth(index)).state).toBe("partial");
  const coverage = resolutionCoverage(index);
  expect(coverage.diagnostics).toEqual({ "scan/file-too-large": 1 });
  expect(coverage.oversizedFiles).toEqual([{ path: "big.ts", size: Buffer.byteLength(big), limitBytes: maximumIndexedFileSizeBytes }]);
  expect(await freshness(index, root)).toEqual({ added: [], changed: [], deleted: [] });
});

it("keeps incremental refresh equal to a full build as a file crosses the cap in both directions", async () => {
  const { root, cacheDir } = await fixture();
  await fs.writeFile(path.join(root, "a.ts"), "export function a() {}\n");
  await fs.writeFile(path.join(root, "big.ts"), "export const b = 1;\n");
  let index = await buildIndex(root, { cacheDir });
  expect(index.diagnostics).toEqual([]);
  const steps: Array<[string, () => Promise<void>, unknown[]]> = [
    ["grow past the cap", () => fs.writeFile(path.join(root, "big.ts"), bigSource("a();")), [tooLarge("big.ts")]],
    ["same-size edit", () => fs.writeFile(path.join(root, "big.ts"), bigSource("b();")), [tooLarge("big.ts")]],
    ["shrink under the cap", () => fs.writeFile(path.join(root, "big.ts"), "a();\n"), []],
    ["grow again", () => fs.writeFile(path.join(root, "big.ts"), bigSource("a();", 5)), [tooLarge("big.ts")]],
    ["delete", () => fs.rm(path.join(root, "big.ts")), []],
  ];
  for (const [label, step, expected] of steps) {
    await step();
    index = await applyChanges(index, root, []);
    const full = await buildIndex(root, { cacheDir });
    expect(serializeArtifact(index).toString(), label).toBe(serializeArtifact(full).toString());
    expect(index.diagnostics, label).toEqual(expected);
    expect(await freshness(index, root), label).toEqual({ added: [], changed: [], deleted: [] });
    expect((await refreshWorkspace(root, { cacheDir })).diagnostics, label).toEqual(expected);
  }
});

it("records a file that grows past the cap after the scan, instead of dropping it", async () => {
  const { root, cacheDir } = await fixture();
  await fs.writeFile(path.join(root, "a.ts"), "export function a() {}\n");
  await fs.writeFile(path.join(root, "grows.ts"), "export const g = 1;\n");
  const outside = path.join(path.dirname(root), "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(root, "linked"), "dir");
  let grown = false;
  const onProgress = (event: ProgressEvent): void => {
    if (event.phase !== "scan" || event.skippedSymlinkedDirectories === undefined || grown) return;
    grown = true;
    writeFileSync(path.join(root, "grows.ts"), bigSource("export const g = 2;"));
  };
  const index = await buildIndex(root, { cacheDir, onProgress });
  expect(grown).toBe(true);
  expect([...index.files.keys()]).toEqual(["a.ts", "grows.ts"]);
  expect(index.diagnostics).toEqual([tooLarge("grows.ts")]);
  expect(await freshness(index, root)).toEqual({ added: [], changed: [], deleted: [] });
});

it("names a tsconfig that cannot be read in the index diagnostics", async () => {
  const { root, cacheDir } = await fixture();
  await fs.writeFile(path.join(root, "tsconfig.json"), '{ "compilerOptions": { "baseUrl": "." } "extra": 1 }\n');
  await fs.writeFile(path.join(root, "a.ts"), "export function a() {}\n");
  const index = await buildIndex(root, { cacheDir });
  expect(index.diagnostics).toEqual([{ phase: "parse", path: "tsconfig.json", code: "config-unparsed" }]);
  expect(resolutionCoverage(index).diagnostics).toEqual({ "parse/config-unparsed": 1 });
});
