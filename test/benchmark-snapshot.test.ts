import { expect, it } from "vitest";
import { parseManifest } from "../scripts/bench/manifest.js";
import { snapshot } from "../scripts/bench/runner.js";

it("shares validated source snapshots without exposing mutable manifest state", async () => {
  const manifest = parseManifest({
    schemaVersion: 1, id: "shared-snapshot",
    source: { kind: "inline", files: { "a.ts": "export const answer = 42;\n" } },
    edit: { file: "a.ts", append: "\n// edit\n" },
    cases: [{ id: "answer", kind: "ask", split: "development", question: "answer", expected: ["a.ts#answer"], anchors: [{ file: "a.ts", text: "answer = 42" }] }],
  });
  const first = await snapshot(manifest);
  expect(first.excluded).toEqual([]);
  expect(first.files.get("a.ts")?.toString()).toBe("export const answer = 42;\n");
  first.files.get("a.ts")?.fill(0);
  expect((await snapshot(manifest)).files.get("a.ts")?.toString()).toBe("export const answer = 42;\n");
});

it("requires explicit checkout input in the shared entry point too", async () => {
  const manifest = parseManifest({
    schemaVersion: 1, id: "explicit-workspace", source: { kind: "checkout", revision: "a".repeat(40) },
    edit: { file: "a.ts", append: "\n// edit\n" },
    cases: [{ id: "a", kind: "ask", split: "development", question: "a", expected: ["a.ts#a"], anchors: [{ file: "a.ts", text: "a" }] }],
  });
  await expect(snapshot(manifest)).rejects.toThrow(/workspace required/);
});
