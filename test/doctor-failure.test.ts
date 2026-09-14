import { expect, it, vi } from "vitest";
import { doctor } from "../src/diagnostics/doctor.js";

vi.mock("../src/grammar/loader.js", () => ({
  getParser: vi.fn(async () => { throw new Error("FAKE_SECRET=never-echo-dependency-errors"); }),
}));

it("reports unavailable grammar capabilities without rendering underlying errors", async () => {
  const report = await doctor(process.cwd());
  expect(report.ok).toBe(false);
  expect(report.capabilities).toHaveLength(8);
  expect(report.capabilities.every((capability) => capability.status === "error")).toBe(true);
  expect(report.checks.filter((check) => check.id.startsWith("grammar:") && check.status === "error")).toHaveLength(8);
  expect(JSON.stringify(report)).not.toContain("never-echo-dependency-errors");
});
