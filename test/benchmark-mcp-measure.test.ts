import { describe, expect, it } from "vitest";
import { describeSamples, parseProcStatus, payloadShape } from "../scripts/bench/mcp-measure.js";

describe("benchmark MCP measurement helpers", () => {
  it("reads resident and peak resident memory from /proc status text", () => {
    const status = ["Name:\tnode", "VmPeak:\t 1234567 kB", "VmHWM:\t  204800 kB", "VmRSS:\t  102400 kB", "Threads:\t11"].join("\n");
    expect(parseProcStatus(status)).toEqual({ rssKiB: 102_400, hwmKiB: 204_800, threads: 11 });
  });

  it("reports missing memory fields as null instead of zero", () => {
    expect(parseProcStatus("Name:\tzombie\nState:\tZ (zombie)\n")).toEqual({ rssKiB: null, hwmKiB: null, threads: null });
  });

  it("summarizes samples with nearest-rank percentiles and keeps the raw samples", () => {
    const samples = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    expect(describeSamples(samples)).toEqual({
      count: 20, p50: 10, p95: 19, min: 1, max: 20, mean: 10.5, samples,
    });
  });

  it("returns null statistics for an empty sample set", () => {
    expect(describeSamples([])).toEqual({ count: 0, p50: null, p95: null, min: null, max: null, mean: null, samples: [] });
  });

  it("measures a payload and detects output clipping and omission counts", () => {
    const plain = "osnova generation abc\nsrc/a.ts:1 function a\n";
    expect(payloadShape(plain)).toEqual({ codeUnits: plain.length, bytes: plain.length, lines: 3, clipped: false, clippedCodeUnits: null, reportsOmissions: false });
    const clipped = "x\nomitted: 3 of 9 signatures\n[output truncated: 1234 UTF-16 code units omitted; counts above describe the query result before output clipping. Use the API or narrow the query.]";
    expect(payloadShape(clipped)).toMatchObject({ clipped: true, clippedCodeUnits: 1234, reportsOmissions: true });
    expect(payloadShape("é").bytes).toBe(2);
  });
});
