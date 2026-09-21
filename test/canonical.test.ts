import { describe, expect, it } from "vitest";
import { canonical } from "../src/index/edgeStore.js";

function reference(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "object" && item !== null && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item);
}

const fixtures: readonly unknown[] = [
  null,
  true,
  false,
  0,
  -0,
  1.5,
  -42,
  1e21,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  "",
  "plain",
  "quote\" backslash\\ newline\n tab\t nul\u0000 ctrl\u001f",
  "unicode é中😀 lone surrogate \ud800",
  [],
  [undefined, null, 1, "a", undefined],
  [() => 1, Symbol("s"), undefined],
  {},
  { b: 1, a: 2, c: undefined, d: null },
  { z: { y: { x: [{ k: undefined, j: [undefined] }, 3] } }, a: [] },
  { "10": "ten", "9": "nine", b: 1, "2": "two", "01": "zero-one", "-1": "minus", a: 0, "4294967295": "over", "4294967294": "max" },
  { "é": 1, "中": 2, E: 3, e: 4, "": 5, " ": 6 },
  { source: "unknown" },
  { source: "import-binding", target: "src/a.ts#f", tier: 1, blocked: undefined },
  { kind: "receiver", owner: "src/a.ts#C", isStatic: false, decorators: ["x", undefined, null], nested: { b: undefined, a: undefined } },
  { toJSON: () => ({ b: 1, a: 2 }) },
  { when: new Date(0), list: [new Date(1), { t: new Date(2) }] },
  { nested: [[{ b: [1, { d: undefined, c: 2 }], a: undefined }]] },
];

describe("canonical", () => {
  it.each(fixtures.map((value, i) => [i, value] as const))("matches sorted JSON.stringify for fixture %i", (_i, value) => {
    expect(canonical(value)).toBe(reference(value));
  });

  it("matches sorted JSON.stringify for the whole fixture list", () => {
    expect(canonical(fixtures)).toBe(reference(fixtures));
  });

  it("round-trips through JSON.parse without changing shape", () => {
    const value = { b: [1, { d: "x", c: null }], a: { z: true, y: "é" } };
    expect(JSON.parse(canonical(value))).toEqual(JSON.parse(reference(value)));
  });
});
