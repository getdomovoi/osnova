import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { workspaceIdentity } from "../src/index/workspace.js";
import { canonicalWorkspaceRoot } from "../src/index/workspace.js";

describe("workspace identity", () => {
  it("matches the canonical root for a temporary directory on every platform", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-identity-"));
    try {
      expect(workspaceIdentity(root)).toBe(await canonicalWorkspaceRoot(root));
      expect(workspaceIdentity(root)).toBe(await fs.realpath(root));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("extends a canonical ancestor with the missing suffix", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-identity-"));
    try {
      const missing = path.join(root, "not", "yet");
      expect(workspaceIdentity(missing)).toBe(path.join(await fs.realpath(root), "not", "yet"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
