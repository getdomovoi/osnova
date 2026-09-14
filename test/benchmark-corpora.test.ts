import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parseManifest, manifestFingerprint } from "../scripts/bench/manifest.js";

it("keeps every committed corpus valid, uniquely identified and split", async () => {
  const directory = fileURLToPath(new URL("../benchmarks/", import.meta.url));
  const files = (await fs.readdir(directory)).filter((file) => file.endsWith(".json")).sort();
  expect(files.length).toBeGreaterThanOrEqual(4);
  const ids = new Set<string>();
  for (const file of files) {
    const manifest = parseManifest(JSON.parse(await fs.readFile(`${directory}/${file}`, "utf8")));
    expect(ids.has(manifest.id), file).toBe(false);
    ids.add(manifest.id);
    expect(manifest.cases.some((item) => item.split === "development"), file).toBe(true);
    expect(manifest.cases.some((item) => item.split === "evaluation"), file).toBe(true);
    expect(manifestFingerprint(manifest)).toMatch(/^[a-f0-9]{64}$/);
  }
});
