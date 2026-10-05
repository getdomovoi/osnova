import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The oracle README names the version its recorded run used. The release relabelled the record
// from 0.11.0 to 0.12.0 and the paragraph kept the old number, so read it from the record.
const root = fileURLToPath(new URL("..", import.meta.url));
const record = JSON.parse(readFileSync(path.join(root, "benchmarks", "results", "type-checker-oracle-2026-09-30.json"), "utf8")) as {
  osnova: { version: string };
};

it("names the version the oracle record was measured with", () => {
  const readme = readFileSync(path.join(root, "benchmarks", "oracle", "README.md"), "utf8");
  expect(/The recorded run used Osnova (\d+\.\d+\.\d+)/.exec(readme)?.[1]).toBe(record.osnova.version);
});
