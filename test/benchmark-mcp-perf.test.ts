import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { promises as fs, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseManifest } from "../scripts/bench/manifest.js";
import { describeSamples } from "../scripts/bench/mcp-measure.js";
import { emptyReport, finalizeReport, measureBuild, measureWorkload, mcpToolNames, omissionCounts, queryPeakKiB } from "../scripts/bench/mcp-perf.js";
import type { McpQuery, QueryMeasurement, WorkloadReport } from "../scripts/bench/mcp-perf.js";

const root = path.join(import.meta.dirname, "..");

const manifest = parseManifest({
  schemaVersion: 1, id: "mcp-smoke",
  source: { kind: "inline", files: {
    "src/a.ts": "export function alpha(): number { return beta(); }\nexport function beta(): number { return 1; }\n",
    "test/a.test.ts": "import { alpha } from \"../src/a.js\";\nalpha();\n",
  } },
  edit: { file: "src/a.ts", append: "\n// benchmark edit\n" },
  cases: [{ id: "alpha", split: "development", kind: "ask", question: "alpha", expected: ["src/a.ts#alpha"], anchors: [{ file: "src/a.ts", text: "alpha" }] }],
});

const argumentsByTool: Record<string, Record<string, unknown>> = {
  osnova_ground: { question: "alpha" },
  osnova_thread: { pattern: "beta", fixed: true },
  osnova_outline: { file: "src/a.ts" },
  osnova_warp: { symbol: "src/a.ts#beta" },
  osnova_groundwork: {},
  osnova_footing: { question: "alpha" },
  osnova_settle: { diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -2,1 +2,1 @@\n-x\n+y\n" },
  osnova_plumb: { symbol: "src/a.ts#beta", sites: ["src/a.ts:1"] },
  osnova_tests: { symbols: ["src/a.ts#alpha"] },
  osnova_unreferenced: {},
};

describe("benchmark MCP harness", () => {
  it("measures builds, refreshes, cold starts, warm queries and memory for one workload", async () => {
    const queries: McpQuery[] = mcpToolNames.map((tool) => ({ id: tool, tool, arguments: argumentsByTool[tool] ?? {}, size: "small", expectEmpty: false }));
    const report = await measureWorkload({
      manifest, queries, samples: 2, warmups: 1, coldSamples: 1, buildSamples: 2, editSamples: 1, settleMs: 0,
      bin: path.join(root, "dist/bin.js"),
    });
    expect(report.errors).toEqual([]);
    expect(report.status).toBe("completed");
    expect(report.builds).toHaveLength(2);
    expect(new Set(report.builds.map((build) => build.artifactSha256)).size).toBe(1);
    expect(report.refresh.noChangeMemory.count).toBe(2);
    expect(report.refresh.edited.map((sample) => sample.incrementalEqualsFull)).toEqual([true]);
    expect(report.refresh.editedDecomposed.map((sample) => sample.incrementalEqualsFull)).toEqual([true]);
    expect(report.mcp.coldBuild).toHaveLength(1);
    expect(report.mcp.coldBuild[0]?.artifactSha256).toBe(report.builds[0]?.artifactSha256);
    expect(report.mcp.coldPersisted).toHaveLength(1);
    for (const mode of [report.mcp.warmStdio, report.mcp.warmInProcess]) {
      expect(mode.queries.map((query) => query.id)).toEqual([...mcpToolNames]);
      for (const query of mode.queries) {
        expect(query.latencyMs.count, query.id).toBe(2);
        expect(query.errors, query.id).toEqual([]);
        expect(query.stableResponse, query.id).toBe(true);
      }
    }
    for (const [i, query] of report.mcp.warmStdio.queries.entries()) {
      expect(query.preview?.length, query.id).toBeGreaterThan(0);
      expect(query.preview?.length, query.id).toBeLessThanOrEqual(600);
      expect(query.response?.length, query.id).toBe(query.payload?.codeUnits);
      expect(createHash("sha256").update(query.response ?? "").digest("hex"), query.id).toBe(query.responseSha256);
      expect(query.omissionCounts, query.id).toEqual(omissionCounts(query.response ?? ""));
      expect(report.mcp.warmInProcess.queries[i]?.preview, query.id).toBeNull();
      expect(report.mcp.warmInProcess.queries[i]?.response, query.id).toBeNull();
      expect(report.mcp.warmInProcess.queries[i]?.responseSha256, query.id).toBe(query.responseSha256);
      expect(report.mcp.warmInProcess.queries[i]?.omissionCounts, query.id).toEqual(query.omissionCounts);
    }
    expect(report.mcp.warmStdio.queries.find((query) => query.tool === "osnova_unreferenced")?.omissionCounts?.length).toBeGreaterThan(0);
    if (process.platform === "linux") {
      expect(report.mcp.memory.idle.rssKiB).toBeGreaterThan(0);
      expect(report.mcp.memory.sampledMaxRssKiB).toBeGreaterThan(0);
      if (report.mcp.memory.peakResetApplied) expect(report.mcp.memory.peakDuringQueryKiB).toBeGreaterThan(0);
      else expect(report.mcp.memory.peakDuringQueryKiB).toBeNull();
    }
  }, 180_000);
});

describe("benchmark MCP harness first build", () => {
  // buildIndex persists its own artifact; the harness then serializes, saves again (a write and rename, so a new
  // inode) and rereads it. A probe that still sees buildIndex's inode ran before that extra work.
  it("reads peak memory when buildIndex returns, before the harness serializes, saves and rereads the artifact", async () => {
    const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "osnova-mcp-build-")));
    try {
      const workspace = path.join(temporary, "workspace");
      await fs.mkdir(path.join(workspace, "src"), { recursive: true });
      await fs.writeFile(path.join(workspace, "src/a.ts"), "export function alpha(): number { return 1; }\n");
      const cacheDir = path.join(temporary, "cache");
      const artifactInodes = (): number[] => readdirSync(cacheDir, { recursive: true }).map(String)
        .filter((file) => path.basename(file) === "index.json").map((file) => statSync(path.join(cacheDir, file)).ino);
      let inodesAtProbe: number[] = [];
      const sample = await measureBuild(workspace, cacheDir, () => { inodesAtProbe = artifactInodes(); return 4_242; });
      expect(sample.maxRssKiB).toBe(4_242);
      expect(inodesAtProbe).toHaveLength(1);
      expect(artifactInodes()).toHaveLength(1);
      expect(artifactInodes()).not.toEqual(inodesAtProbe);
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  });
});

describe("benchmark MCP harness omission counts", () => {
  it("keeps every omission line with its exact counts, wherever it falls in the answer", () => {
    const answer = [
      "osnova outline: src/big.ts",
      ...Array.from({ length: 40 }, (_, i) => `function f${i}(value: number): number src/big.ts:${i * 10 + 1}-${i * 10 + 9}`),
      "omitted: 712 of 752 signatures; selected by indexed edge degree, then source order. Use skeleton API for the complete file.",
      "- test/a.test.ts (resolved edge): test/a.test.ts:12,15 call alpha; +3 more sites",
      "8 line numbers per symbol; 41 sites not listed",
      "osnova unreferenced: scope ., kinds function, 50 candidates listed of 1204, 7 exported not listed, 0 shadowed not listed, 9000 symbols examined",
      "[output truncated: 16123 UTF-16 code units omitted; counts above describe the query result before output clipping. Use the API or narrow the query.]",
    ].join("\n");
    expect(answer.indexOf("omitted: 712")).toBeGreaterThan(600);
    expect(omissionCounts(answer)).toEqual([
      { line: 42, text: "omitted: 712 of 752 signatures; selected by indexed edge degree, then source order. Use skeleton API for the complete file.", counts: [712, 752] },
      { line: 43, text: "- test/a.test.ts (resolved edge): test/a.test.ts:12,15 call alpha; +3 more sites", counts: [3] },
      { line: 44, text: "8 line numbers per symbol; 41 sites not listed", counts: [8, 41] },
      {
        line: 45, text: "osnova unreferenced: scope ., kinds function, 50 candidates listed of 1204, 7 exported not listed, 0 shadowed not listed, 9000 symbols examined",
        counts: [50, 1204, 7, 0, 9000],
      },
      {
        line: 46, text: "[output truncated: 16123 UTF-16 code units omitted; counts above describe the query result before output clipping. Use the API or narrow the query.]",
        counts: [16123],
      },
    ]);
  });

  it("records no omission lines for an answer that omits nothing", () => {
    expect(omissionCounts("osnova outline: src/a.ts\nfunction alpha(): number src/a.ts:1-1\n")).toEqual([]);
  });
});

describe("benchmark MCP harness query peak memory", () => {
  const afterQueries = { rssKiB: 90_000, hwmKiB: 250_000, threads: 12 };

  it("reports the peak since the reset as the query peak", () => {
    expect(queryPeakKiB(true, afterQueries)).toBe(250_000);
  });

  it("reports the query peak as unknown when the peak could not be reset", () => {
    expect(queryPeakKiB(false, afterQueries)).toBeNull();
  });
});

const measured = (id: string, stableResponse: boolean): QueryMeasurement => ({
  id, tool: "osnova_ground", arguments: { question: id }, size: "small", expectEmpty: false, note: null, latencyMs: describeSamples([1, 2]),
  warmupMs: [], payload: null, responseSha256: null, preview: null, response: null, omissionCounts: null, stableResponse, excludedRefreshSamples: 0, errors: [],
});

function completedReport(): WorkloadReport {
  const report = emptyReport({
    manifest, queries: [], samples: 2, warmups: 0, coldSamples: 1, buildSamples: 1, editSamples: 1, settleMs: 0, bin: path.join(root, "dist/bin.js"),
  });
  report.refresh.repeatedSerializeIdentical = true;
  report.mcp.warmStdio.queries = [measured("ground", true)];
  report.mcp.warmInProcess.queries = [measured("ground", true)];
  return report;
}

describe("benchmark MCP harness verdict", () => {
  it("completes a run whose determinism probes held", () => {
    const report = finalizeReport(completedReport());
    expect(report.errors).toEqual([]);
    expect(report.status).toBe("completed");
  });

  it("fails a run whose repeated queries returned different responses", () => {
    const report = completedReport();
    report.mcp.warmInProcess.queries = [measured("ground", false)];
    finalizeReport(report);
    expect(report.status).toBe("failed");
    expect(report.errors).toEqual(["ground: in-process responses differ across samples"]);
  });

  it("fails a run whose repeated serialization produced different bytes", () => {
    const report = completedReport();
    report.refresh.repeatedSerializeIdentical = false;
    finalizeReport(report);
    expect(report.status).toBe("failed");
    expect(report.errors).toEqual(["repeated serialization of one index produced different bytes"]);
  });
});
