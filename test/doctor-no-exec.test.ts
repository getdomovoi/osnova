import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { doctor } from "../src/diagnostics/doctor.js";
import { OSNOVA_VERSION } from "../src/version.js";

let home: string;
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-doctor-noexec-")); });
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });

async function marker(name: string): Promise<{ script: string; evidence: string }> {
  const evidence = path.join(home, `${name}.ran`);
  const script = path.join(home, `${name}.js`);
  await fs.writeFile(script, `require("node:fs").writeFileSync(${JSON.stringify(evidence)}, process.argv.slice(2).join(" "));\nconsole.log(${JSON.stringify(OSNOVA_VERSION)});\n`);
  return { script, evidence };
}

async function install(dir: string, version: string): Promise<string> {
  await fs.mkdir(path.join(dir, "dist"), { recursive: true });
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "@getdomovoi/osnova", version, bin: { osnova: "dist/bin.js" } }));
  const bin = path.join(dir, "dist", "bin.js");
  await fs.writeFile(bin, "#!/usr/bin/env node\nthrow new Error('osnova doctor must not run this');\n");
  return bin;
}

describe("osnova doctor stays read-only", () => {
  it("never runs the program named by the osnova MCP entry in ~/.claude.json", async () => {
    const { script, evidence } = await marker("mcp");
    await fs.writeFile(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { osnova: { command: process.execPath, args: [script, "mcp"] } } }));
    const report = await doctor(home, { cacheDir: path.join(home, "cache"), home });
    expect(report.readOnly).toBe(true);
    await expect(fs.access(evidence)).rejects.toThrow();
    expect(report.checks.find((check) => check.id === "client:mcp")?.status).toBe("warning");
  });

  it("never runs the program named by an osnova hook in ~/.claude/settings.json", async () => {
    const { script, evidence } = await marker("hook");
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    await fs.writeFile(path.join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)} osnova hook stop` }] }] } }));
    await doctor(home, { cacheDir: path.join(home, "cache"), home });
    await expect(fs.access(evidence)).rejects.toThrow();
  });

  it("never runs a shell named as the MCP command", async () => {
    const evidence = path.join(home, "shell.ran");
    await fs.writeFile(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { osnova: { command: "/bin/sh", args: ["-c", `echo ran > ${evidence}`, "mcp"] } } }));
    await doctor(home, { cacheDir: path.join(home, "cache"), home });
    await expect(fs.access(evidence)).rejects.toThrow();
  });

  it("reads the version of the install a configured command resolves to", async () => {
    const same = await install(path.join(home, "same"), OSNOVA_VERSION);
    const older = await install(path.join(home, "older"), "0.0.1");
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    await fs.writeFile(path.join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(older)} hook stop` }] }] } }));
    await fs.writeFile(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { osnova: { command: same, args: ["mcp"] } } }));
    const report = await doctor(home, { cacheDir: path.join(home, "cache"), home });
    const hook = report.checks.find((check) => check.id === "client:hook");
    const mcp = report.checks.find((check) => check.id === "client:mcp");
    expect(hook?.status).toBe("warning");
    expect(hook?.message).toContain("0.0.1");
    expect(mcp?.status).toBe("ok");
    expect(mcp?.message).toContain(OSNOVA_VERSION);
  });

  it("finds the package behind a node_modules/.bin shim that is not a symlink", async () => {
    const project = path.join(home, "project");
    await install(path.join(project, "node_modules", "@getdomovoi", "osnova"), "0.0.2");
    await fs.mkdir(path.join(project, "node_modules", ".bin"), { recursive: true });
    const shim = path.join(project, "node_modules", ".bin", "osnova");
    await fs.writeFile(shim, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await fs.writeFile(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { osnova: { command: shim, args: ["mcp"] } } }));
    const report = await doctor(home, { cacheDir: path.join(home, "cache"), home });
    const mcp = report.checks.find((check) => check.id === "client:mcp");
    expect(mcp?.status).toBe("warning");
    expect(mcp?.message).toContain("0.0.2");
  });
});
