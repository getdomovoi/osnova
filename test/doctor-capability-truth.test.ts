import { afterAll, beforeAll, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index/build.js";
import { doctor } from "../src/diagnostics/index.js";

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-doctor-truth-"));
  await fs.writeFile(path.join(root, "a.dart"), "int helper() => 1;\nint main() { return helper(); }\n");
});

afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

it("does not tell a user Dart has no call edges when it extracts them", async () => {
  const index = await buildIndex(root);
  const calls = index.edges.filter((edge) => edge.kind === "calls" && edge.fromFile === "a.dart");
  expect(calls.length).toBeGreaterThan(0);
  const report = await doctor(root, { cacheDir: path.join(root, "cache") });
  const dart = report.capabilities.find((capability) => capability.language === "dart");
  expect(dart?.limitations.join("\n")).not.toMatch(/call edges are not extracted/i);
});
