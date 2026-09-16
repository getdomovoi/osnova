import { describe, expect, it } from "vitest";
import { manifestFingerprint, parseManifest } from "../scripts/bench/manifest.js";

function manifest(): Record<string, unknown> {
  return {
    schemaVersion: 1, id: "tiny-v1",
    source: { kind: "inline", files: { "src/a.ts": "export function alpha() {}\n" } },
    edit: { file: "src/a.ts", append: "\n// benchmark edit\n" },
    cases: [{ id: "alpha", split: "development", kind: "ask", question: "alpha", expected: ["src/a.ts#alpha"],
      anchors: [{ file: "src/a.ts", text: "function alpha" }] }],
  };
}

describe("benchmark manifest", () => {
  it("accepts inline corpora and pins all source and task content in the fingerprint", () => {
    const original = parseManifest(manifest());
    expect(manifestFingerprint(original)).toMatch(/^[a-f0-9]{64}$/);
    const reordered = { cases: original.cases, edit: original.edit, source: original.source, id: original.id, schemaVersion: 1 };
    expect(manifestFingerprint(parseManifest(reordered))).toBe(manifestFingerprint(original));
    const changed = manifest();
    changed.source = { kind: "inline", files: { "src/a.ts": "changed source" } };
    expect(manifestFingerprint(parseManifest(changed))).not.toBe(manifestFingerprint(original));
  });

  it("requires immutable full revision pins for checkout corpora", () => {
    const input = manifest();
    input.source = { kind: "checkout", revision: "main" };
    expect(() => parseManifest(input)).toThrow(/revision/);
    input.source = { kind: "checkout", revision: "a".repeat(40) };
    expect(parseManifest(input).source.kind).toBe("checkout");
  });

  it.each(["../outside.ts", "/absolute.ts", "C:/absolute.ts", "a/../../outside", "a\\b", ".git/config"])("rejects unsafe input paths: %s", (file) => {
    const input = manifest();
    input.source = { kind: "inline", files: { [file]: "content" } };
    expect(() => parseManifest(input)).toThrow(/path/);
  });

  it("rejects duplicate case IDs and missing relevance labels", () => {
    const input = manifest();
    const cases = input.cases as Array<Record<string, unknown>>;
    cases.push({ ...cases[0] });
    expect(() => parseManifest(input)).toThrow(/duplicate/);
    cases.pop();
    const first = cases[0];
    if (first === undefined) throw new Error("missing fixture");
    first.expected = [];
    expect(() => parseManifest(input)).toThrow(/relevance/);
  });

  it("requires source anchors independently of the extractor", () => {
    const input = manifest();
    const first = (input.cases as Array<Record<string, unknown>>)[0];
    if (first === undefined) throw new Error("missing fixture");
    first.anchors = [];
    expect(() => parseManifest(input)).toThrow(/anchors/);
  });

  it("does not allow exclusions to hide the edit or ground-truth sources", () => {
    const input = manifest();
    input.source = { kind: "checkout", revision: "a".repeat(40), exclude: ["src"] };
    expect(() => parseManifest(input)).toThrow(/exclusion/);
    input.edit = { file: "other.ts", append: "\n// edit" };
    expect(() => parseManifest(input)).toThrow(/exclusion/);
    input.source = { kind: "checkout", revision: "a".repeat(40), exclude: ["hidden.ts"] };
    const first = (input.cases as Array<Record<string, unknown>>)[0];
    if (first === undefined) throw new Error("missing fixture");
    first.expected = ["hidden.ts#answer"];
    expect(() => parseManifest(input)).toThrow(/exclusion/);
  });

  it("validates exclusion paths and includes them in the manifest fingerprint", () => {
    const input = manifest();
    input.source = { kind: "checkout", revision: "a".repeat(40), exclude: ["../outside"] };
    expect(() => parseManifest(input)).toThrow(/path/);
    input.source = { kind: "checkout", revision: "a".repeat(40), exclude: [".config"] };
    const excluded = manifestFingerprint(parseManifest(input));
    input.source = { kind: "checkout", revision: "a".repeat(40) };
    expect(manifestFingerprint(parseManifest(input))).not.toBe(excluded);
  });
});
