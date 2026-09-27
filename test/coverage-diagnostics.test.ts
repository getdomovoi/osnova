import { afterEach, beforeEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index.js";
import { resolutionCoverage } from "../src/query/coverage.js";

let temporary: string;
beforeEach(async () => { temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-coverage-diagnostics-")); });
afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }); });

it("counts the index diagnostics by phase and code so a JSON consumer can see a partial corpus", async () => {
  const workspace = path.join(temporary, "ws");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "a.ts"), "export function a() { b(); }\n");
  await fs.writeFile(path.join(workspace, "b.ts"), "export function b( {\n");
  await fs.writeFile(path.join(workspace, "c.ts"), "export const c = (;\n");
  const index = await buildIndex(workspace, { cacheDir: path.join(temporary, "cache") });
  expect(index.diagnostics?.length).toBe(2);
  const report = resolutionCoverage(index);
  expect(report.diagnostics).toEqual({ "parse/syntax-errors": 2 });
  expect(JSON.parse(JSON.stringify(report)).diagnostics).toEqual({ "parse/syntax-errors": 2 });
});

it("reports an empty diagnostics record for a clean corpus", async () => {
  const workspace = path.join(temporary, "ws");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "a.ts"), "export function a() {}\n");
  const index = await buildIndex(workspace, { cacheDir: path.join(temporary, "cache") });
  expect(resolutionCoverage(index).diagnostics).toEqual({});
});
