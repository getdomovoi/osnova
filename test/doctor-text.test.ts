import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../src/cli/cli.js";
import { formatDoctor } from "../src/query/format.js";
import type { DoctorReport } from "../src/diagnostics/index.js";

let root: string;

beforeAll(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-doctor-text-")); });
afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function doctorCli(extra: string[] = []): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  const code = await runCli(["doctor", "--workspace", root, "--cache-dir", path.join(root, "cache"), ...extra], {
    stdout: (text) => lines.push(text), stderr: () => {},
  });
  return { code, text: lines.join("\n") };
}

describe("osnova doctor", () => {
  it("prints a readable report by default", async () => {
    const { text } = await doctorCli();
    expect(() => JSON.parse(text)).toThrow();
    expect(text).toMatch(/^osnova doctor: (ok|failed), read-only\n/);
    expect(text.split("\n").length).toBeGreaterThan(5);
    expect(text).toMatch(/^ {2}syntax, binding and receiver hints \(4\): javascript, python, tsx, typescript$/m);
    expect(text).toMatch(/^ {2}tags query, name heuristics \(\d+\): bash, /m);
  });

  it("says what a green grammar check does and does not prove", async () => {
    const { text } = await doctorCli();
    expect(text).toContain("grammar checks parse a short synthetic snippet");
    expect(text).toContain("not that every real file parses");
  });

  it("keeps the full report available as JSON", async () => {
    const { text } = await doctorCli(["--json"]);
    const report = JSON.parse(text) as DoctorReport;
    expect(report.readOnly).toBe(true);
    expect(report.capabilities.length).toBe(21);
  });

  it("lists every check that is not ok, with its message", () => {
    const report: DoctorReport = {
      ok: false, readOnly: true, fallback: "Other files get cards.",
      checks: [
        { id: "runtime", status: "ok", message: "fine" },
        { id: "cache", status: "error", message: "cache directory is not writable" },
        { id: "client:hook+mcp", status: "warning", message: "installed hook is older than this build" },
      ],
      capabilities: [],
    };
    const text = formatDoctor(report);
    expect(text).toMatch(/^osnova doctor: failed, read-only\n/);
    expect(text).toContain("checks: 1 ok, 1 warning, 1 error");
    expect(text).toContain("  error cache: cache directory is not writable");
    expect(text).toContain("  warning client:hook+mcp: installed hook is older than this build");
    expect(text).not.toContain("runtime: fine");
  });

  it("names a language whose grammar failed to load", () => {
    const report: DoctorReport = {
      ok: false, readOnly: true, fallback: "",
      checks: [],
      capabilities: [{ language: "zig", extensions: [".zig"], status: "error", extraction: "tags", resolution: "name-heuristics", typeInference: false, limitations: [] }],
    };
    expect(formatDoctor(report)).toContain("tags query, name heuristics (1): zig (grammar failed to load)");
  });
});
