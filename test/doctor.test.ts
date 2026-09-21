import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { doctor } from "../src/diagnostics/doctor.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-repo");
const cacheDir = ".tmp-coverage-cache";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it("probes every grammar and reports cache access without creating it or reading source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "osnova-doctor-"));
  roots.push(root);
  await writeFile(path.join(root, ".env"), "FAKE_SECRET=not-for-output");
  const report = await doctor(root, { cacheDir: path.join(root, "absent", "cache") });
  expect(report.ok).toBe(true);
  expect(report.checks.find((check) => check.id === "cache")?.status).toBe("warning");
  expect(report.capabilities).toHaveLength(21);
  expect(report.capabilities.every((capability) => capability.status === "ok")).toBe(true);
  expect(report.capabilities.every((capability) => capability.typeInference === false)).toBe(true);
  expect(JSON.stringify(report)).not.toContain("not-for-output");
  expect(await readdir(root)).toEqual([".env"]);
});

it("reports missing workspace and file-valued cache instead of healthy empty results", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "osnova-doctor-"));
  roots.push(root);
  await writeFile(path.join(root, "cache"), "fake");
  await mkdir(path.join(root, "workspace"));
  const report = await doctor(path.join(root, "missing"), { cacheDir: path.join(root, "cache", "nested") });
  expect(report.ok).toBe(false);
  expect(report.checks.find((check) => check.id === "workspace")?.status).toBe("error");
  expect(report.checks.find((check) => check.id === "cache")?.status).toBe("error");
});

it("reports every breadth language as tags extraction with name heuristics", async () => {
  const report = await doctor(FIXTURE, { cacheDir });
  const rows = report.capabilities.filter((row) => row.extraction === "tags");
  expect(rows.map((row) => row.language).sort()).toEqual(["bash", "c", "cpp", "dart", "elixir", "kotlin", "objc", "ocaml", "php", "ruby", "scala", "swift", "zig"]);
  for (const row of rows) {
    expect(row.status, row.language).toBe("ok");
    expect(row.resolution).toBe("name-heuristics");
    expect(row.limitations.join(" ")).toMatch(/import|export/);
  }
  expect(report.capabilities).toHaveLength(21);
});
