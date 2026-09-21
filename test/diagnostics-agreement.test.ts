import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildIndex } from "../src/index/build.js";
import { EXTRACT_POOL_MIN_FILES } from "../src/index/extractPool.js";
import { serializeArtifact } from "../src/index/serialize.js";
import { loadIndex, refreshWorkspace } from "../src/api.js";
import { runCli } from "../src/cli/cli.js";
import { createOsnovaMcpServer } from "../src/mcp/server.js";
import { formatIndexDiagnostics, formatIndexHealthSummary } from "../src/query/format.js";
import type { IndexDiagnostic } from "../src/types.js";

const variance = [
  "src/variance/classic.ts",
  "src/variance/core.ts",
  "src/variance/mini.ts",
  "src/variance/checks.ts",
] as const;

const expected: readonly IndexDiagnostic[] = [...variance]
  .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  .map((file) => ({ phase: "parse", path: file, code: "syntax-errors" }));

function capture(): { lines: string[]; io: { stdout: (t: string) => void; stderr: (t: string) => void } } {
  const lines: string[] = [];
  return { lines, io: { stdout: (t) => lines.push(...t.split("\n")), stderr: (t) => lines.push(...t.split("\n")) } };
}

let temporary: string;
let workspace: string;
let cacheDir: string;
const previousWorkers = process.env.OSNOVA_EXTRACT_WORKERS;

beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-diag-agree-"));
  workspace = path.join(temporary, "workspace");
  cacheDir = path.join(temporary, "cache");
  fs.cpSync(path.join(import.meta.dirname, "fixtures", "sample-repo"), workspace, { recursive: true });
  fs.mkdirSync(path.join(workspace, "src", "variance"));
  for (const [index, file] of variance.entries()) {
    fs.writeFileSync(
      path.join(workspace, file),
      `export interface Box${index}<out T> {\n  readonly value: T;\n}\nexport function unbox${index}<T>(box: Box${index}<T>): T {\n  return box.value;\n}\n`,
    );
  }
  for (let number = 0; number < EXTRACT_POOL_MIN_FILES; number += 1) {
    fs.writeFileSync(path.join(workspace, "src", `filler${number}.ts`), `export const filler${number} = ${number};\n`);
  }
});

afterEach(() => {
  if (previousWorkers === undefined) delete process.env.OSNOVA_EXTRACT_WORKERS;
  else process.env.OSNOVA_EXTRACT_WORKERS = previousWorkers;
  fs.rmSync(temporary, { recursive: true, force: true });
});

describe("syntax-error diagnostics agree across build, artifact and query surfaces", () => {
  it("pooled and sequential builds report the same non-empty diagnostics and bytes", async () => {
    process.env.OSNOVA_EXTRACT_WORKERS = "0";
    const sequential = await buildIndex(workspace, { cacheDir: path.join(cacheDir, "sequential") });
    process.env.OSNOVA_EXTRACT_WORKERS = "3";
    const pooled = await buildIndex(workspace, { cacheDir: path.join(cacheDir, "pooled") });
    expect(sequential.diagnostics).toEqual(expected);
    expect(pooled.diagnostics).toEqual(expected);
    expect([...pooled.files.values()].map((card) => card.diagnostics)).toEqual([...sequential.files.values()].map((card) => card.diagnostics));
    expect(serializeArtifact(pooled).equals(serializeArtifact(sequential))).toBe(true);
    expect(formatIndexDiagnostics(pooled)).toBe(formatIndexDiagnostics(sequential));
    expect(formatIndexHealthSummary(pooled)).toBe("osnova foundation: partial (parse/syntax-errors=4); some files did not parse fully");
  });

  it("build summary, stored artifact, CLI query and MCP health line name the same set", async () => {
    process.env.OSNOVA_EXTRACT_WORKERS = "3";
    const build = capture();
    expect(await runCli(["build", workspace, "--cache-dir", cacheDir], build.io)).toBe(0);
    const summary = build.lines.filter((line) => line.includes("syntax-errors") || line.includes("foundation"));
    expect(summary).toEqual([
      "osnova foundation: partial, 4 diagnostics; results may be incomplete",
      ...expected.map((diagnostic) => `parse ${diagnostic.path}: syntax-errors`),
    ]);

    const stored = await loadIndex(workspace, { cacheDir });
    expect(stored?.diagnostics).toEqual(expected);
    const artifact = JSON.parse(fs.readFileSync(path.join(cacheDir, fs.readdirSync(cacheDir)[0] ?? "", "index.json"), "utf8")) as {
      files: Array<{ path: string; diagnostics: IndexDiagnostic[] }>;
    };
    expect(artifact.files.flatMap((file) => file.diagnostics)).toEqual(expected);

    const query = capture();
    expect(await runCli(["ground", "unbox0", "--workspace", workspace, "--cache-dir", cacheDir], query.io)).toBe(0);
    expect(query.lines.filter((line) => line.includes("foundation"))).toEqual(["osnova foundation: partial, 4 diagnostics; results may be incomplete"]);

    const { server } = createOsnovaMcpServer(workspace, { cacheDir });
    const client = new Client({ name: "diag-agree", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "osnova_ground", arguments: { question: "unbox0" } });
      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result)).toContain("osnova foundation: partial (parse/syntax-errors=4); some files did not parse fully");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("refreshing after edits keeps the stored count equal to a full rebuild", async () => {
    process.env.OSNOVA_EXTRACT_WORKERS = "3";
    await buildIndex(workspace, { cacheDir });
    fs.appendFileSync(path.join(workspace, variance[3]), "// touched\n");
    fs.appendFileSync(path.join(workspace, "src", "filler0.ts"), "// touched\n");
    const refreshed = await refreshWorkspace(workspace, { cacheDir });
    expect(refreshed.diagnostics).toEqual(expected);
    const rebuilt = await buildIndex(workspace, { cacheDir: path.join(temporary, "rebuilt") });
    expect(serializeArtifact(refreshed).equals(serializeArtifact(rebuilt))).toBe(true);
  });
});
