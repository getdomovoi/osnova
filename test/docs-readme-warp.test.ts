import { afterAll, beforeAll, expect, it } from "vitest";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndex } from "../src/index/build.js";
import { callersDetailed } from "../src/query/callers.js";
import { formatCallersDetailed } from "../src/query/format.js";

// The README's first concrete output is a warp on this repository, the one example a reader can
// check in thirty seconds. Its counts had drifted twice. When this fails, paste the current output
// back into the README rather than loosening the test: the numbers are the point of the example.
const root = fileURLToPath(new URL("..", import.meta.url));
let cacheDir: string;

beforeAll(async () => { cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-readme-warp-")); });
afterAll(async () => { await fs.rm(cacheDir, { recursive: true, force: true }); });

it("still reproduces the README warp excerpt on this repository", async () => {
  const readme = readFileSync(path.join(root, "README.md"), "utf8");
  const index = await buildIndex(root, { cacheDir });
  const text = formatCallersDetailed(callersDetailed(index, "src/api.ts#refreshWorkspace"));
  const [header, reach] = text.split("\n").filter((line) => line.startsWith("function ") || line.startsWith("reach: "));
  expect(header).toMatch(/^function src\/api\.ts#refreshWorkspace: \d+ indexed edges$/);
  expect(readme).toContain(header);
  expect(readme).toContain(reach);
}, 120_000);
