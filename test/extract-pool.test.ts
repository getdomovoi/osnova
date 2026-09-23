import { describe, expect, it } from "vitest";
import { extractWorkerCount } from "../src/index/extractPool.js";

const env = (value: string | undefined): NodeJS.ProcessEnv => (value === undefined ? {} : { OSNOVA_EXTRACT_WORKERS: value });

describe("extract worker pool", () => {
  it("caps an explicit worker count so a typo cannot spawn thousands of WASM workers", () => {
    expect(extractWorkerCount(10_000, env("4000"))).toBeLessThanOrEqual(32);
    expect(extractWorkerCount(10_000, env("99999"))).toBeLessThanOrEqual(32);
    expect(extractWorkerCount(10_000, env("12"))).toBe(12);
    expect(extractWorkerCount(10_000, env("0"))).toBe(0);
  });
});
