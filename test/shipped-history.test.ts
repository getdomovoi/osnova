import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { earlierShippedFiles, shippedHash } from "../src/diagnostics/shipped-history.js";

// Setup replaces an installed integration file only when it matches an earlier shipped version, so every version a
// release may have shipped must be listed. HEAD is checked always; the whole history when the clone has it.
const root = path.join(import.meta.dirname, "..");
const git = (...args: string[]): string | undefined => {
  try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }); } catch { return undefined; }
};

describe("earlier shipped integration files", () => {
  for (const [file, hashes] of Object.entries(earlierShippedFiles)) {
    it(`lists every earlier version of integrations/${file}`, () => {
      const repoPath = `integrations/${file}`;
      expect(existsSync(path.join(root, repoPath))).toBe(true);
      const current = shippedHash(readFileSync(path.join(root, repoPath), "utf8"));
      const versions = new Set<string>();
      const head = git("show", `HEAD:${repoPath}`);
      if (head !== undefined) versions.add(shippedHash(head));
      if (git("rev-parse", "--is-shallow-repository")?.trim() === "false") {
        for (const commit of (git("log", "--format=%H", "--", repoPath) ?? "").split("\n").filter((line) => line.length > 0)) {
          const text = git("show", `${commit}:${repoPath}`);
          if (text !== undefined) versions.add(shippedHash(text));
        }
      }
      versions.delete(current);
      expect([...versions].filter((hash) => !hashes.includes(hash)), `add these to earlierShippedFiles["${file}"]`).toEqual([]);
    });
  }
});
