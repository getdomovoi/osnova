import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(path.resolve(import.meta.dirname, "../.github/workflows/release.yml"), "utf8");

describe("release workflow", () => {
  // npm reads a bare `dir/file.tgz` as the GitHub shorthand `owner/repo` and runs git ls-remote on it;
  // only a path starting with ./, ../ or / is taken as a file. v0.9.0 failed to publish this way.
  it("hands npm publish a tarball path npm cannot read as a GitHub shorthand", () => {
    const publishes = workflow.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("npm publish "));
    expect(publishes.length).toBeGreaterThan(0);
    for (const line of publishes) {
      const target = line.slice("npm publish ".length).split(" ")[0]!.replace(/^"|"$/g, "");
      expect(target, line).toMatch(/^(?:\.\.?\/|\/)/);
    }
  });
});
