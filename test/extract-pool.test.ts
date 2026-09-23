import { describe, expect, it } from "vitest";
import { extractWithPool, extractWorkerCount } from "../src/index/extractPool.js";

const env = (value: string | undefined): NodeJS.ProcessEnv => (value === undefined ? {} : { OSNOVA_EXTRACT_WORKERS: value });

describe("extract worker pool", () => {
  it("caps an explicit worker count so a typo cannot spawn thousands of WASM workers", () => {
    expect(extractWorkerCount(10_000, env("4000"))).toBeLessThanOrEqual(32);
    expect(extractWorkerCount(10_000, env("99999"))).toBeLessThanOrEqual(32);
    expect(extractWorkerCount(10_000, env("12"))).toBe(12);
    expect(extractWorkerCount(10_000, env("0"))).toBe(0);
  });

  it("fails a file whose worker never answers instead of hanging the build", async () => {
    const silent = new URL(`data:text/javascript,${encodeURIComponent('import { parentPort } from "node:worker_threads"; parentPort.on("message", () => {});')}`);
    const hung = Symbol("hung");
    const outcome = await Promise.race([
      extractWithPool("/nonexistent", ["stuck.ts"], { url: silent }, 1, undefined, 100).then(() => "resolved", (error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve(hung), 3_000)),
    ]);
    expect(outcome).not.toBe(hung);
    expect(String(outcome)).toContain("stalled on stuck.ts");
  });
});
