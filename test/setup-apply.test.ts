import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../src/cli/cli.js";
import { doctor } from "../src/diagnostics/doctor.js";

let home: string;
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-apply-")); });
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });
function capture() { const out: string[] = []; return { out, io: { stdout: (t: string) => out.push(t), stderr: (t: string) => out.push(`ERR ${t}`) } }; }

describe("osnova setup --apply", () => {
  it("writes the MCP entry, the three hooks and the instructions block once, with backups, and is idempotent", async () => {
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    await fs.writeFile(path.join(home, ".claude", "settings.json"), '{\n  "hooks": {\n    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node other.js", "timeout": 5 }] }]\n  },\n  "theme": "dark"\n}\n');
    const agents = path.join(home, "AGENTS.md"); await fs.writeFile(agents, "# Project\n\nRules.\n");
    let c = capture();
    expect(await runCli(["setup", "--apply", "--client", "claude-code", "--hooks", "--instructions", agents, "--home", home, "--command", "osnova"], c.io)).toBe(0);
    const report = c.out.join("\n");
    expect(report).toMatch(/applied: claude-code, create, .*\.claude\.json/);
    expect(report).toMatch(/applied: hooks, append, .*settings\.json \(backup .*settings\.json\.bak-osnova-/);
    expect(report).toMatch(/applied: instructions, append, .*AGENTS\.md \(backup /);
    const settings = JSON.parse(await fs.readFile(path.join(home, ".claude", "settings.json"), "utf8"));
    expect(settings.theme).toBe("dark");
    expect(settings.hooks.UserPromptSubmit).toHaveLength(2);
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toBe("node other.js");
    expect(settings.hooks.UserPromptSubmit[1].hooks[0].command).toBe("osnova hook prompt");
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe("osnova hook session");
    expect(settings.hooks.Stop[0].hooks[0]).toEqual({ type: "command", command: "osnova hook stop", timeout: 30 });
    const claude = JSON.parse(await fs.readFile(path.join(home, ".claude.json"), "utf8"));
    expect(claude.mcpServers.osnova).toEqual({ command: "osnova", args: ["mcp"] });
    const text = await fs.readFile(agents, "utf8");
    expect(text.startsWith("# Project\n\nRules.\n\n<!-- osnova:start -->")).toBe(true);
    expect(text).toContain("osnova_footing");
    expect(text.trimEnd().endsWith("<!-- osnova:end -->")).toBe(true);
    const backups = (await fs.readdir(path.join(home, ".claude"))).filter((name) => name.includes(".bak-osnova-"));
    expect(backups).toHaveLength(1);
    c = capture();
    expect(await runCli(["setup", "--apply", "--client", "claude-code", "--hooks", "--instructions", agents, "--home", home, "--command", "osnova"], c.io)).toBe(0);
    expect(c.out.join("\n")).toMatch(/claude-code, unchanged[\s\S]*hooks, unchanged[\s\S]*instructions, unchanged/);
    expect((await fs.readdir(path.join(home, ".claude"))).filter((name) => name.includes(".bak-osnova-"))).toHaveLength(1);
    expect(await fs.readFile(agents, "utf8")).toBe(text);
    c = capture();
    expect(await runCli(["setup", "--preview", "--hooks", "--home", home], c.io)).toBe(0);
    expect(c.out.join("\n")).toContain("hooks, unchanged");
  });

  it("refuses to write when the MCP entry conflicts, and writes nothing else either", async () => {
    await fs.writeFile(path.join(home, ".claude.json"), '{ "mcpServers": { "osnova": { "command": "elsewhere", "args": ["mcp"] } } }\n');
    const c = capture();
    await expect(runCli(["setup", "--apply", "--client", "claude-code", "--hooks", "--home", home], c.io)).rejects.toThrow(/conflicts with the proposal; nothing was written/);
    await expect(fs.access(path.join(home, ".claude", "settings.json"))).rejects.toThrow();
  });
});

describe("doctor client version check", () => {
  it("warns when a configured hook or MCP command reports another version, ok when it matches", async () => {
    const { OSNOVA_VERSION } = await import("../src/version.js");
    const same = path.join(home, "same.js"); await fs.writeFile(same, `console.log(${JSON.stringify(OSNOVA_VERSION)});\n`);
    const other = path.join(home, "other.js"); await fs.writeFile(other, "console.log('0.0.1');\n");
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    const node = process.execPath;
    await fs.writeFile(path.join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `${JSON.stringify(node)} ${JSON.stringify(other)} hook prompt` }] }] } }));
    await fs.writeFile(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { osnova: { command: node, args: [same, "mcp", "--watch"] } } }));
    const report = await doctor(home, { cacheDir: path.join(home, "cache"), home });
    const hook = report.checks.find((check) => check.id === "client:hook");
    const mcp = report.checks.find((check) => check.id === "client:mcp");
    expect(hook?.status).toBe("warning");
    expect(hook?.message).toContain("0.0.1");
    expect(mcp?.status).toBe("ok");
    expect(report.ok).toBe(true);
  });
});
