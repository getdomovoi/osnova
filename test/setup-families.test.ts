import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../src/cli/cli.js";
import { doctor } from "../src/diagnostics/doctor.js";

let home: string;
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-families-")); });
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });
function capture() { const out: string[] = []; return { out, io: { stdout: (t: string) => out.push(t), stderr: (t: string) => out.push(`ERR ${t}`) } }; }
const at = (...parts: string[]): string => path.join(home, ...parts);

describe("osnova setup claude", () => {
  it("previews by default, then writes the MCP entry, the hooks and the skill, and is idempotent", async () => {
    let c = capture();
    expect(await runCli(["setup", "claude", "--home", home, "--command", "osnova"], c.io)).toBe(0);
    expect(c.out.join("\n")).toMatch(/osnova setup preview: claude-code, create, .*\.claude\.json/);
    expect(existsSync(at(".claude.json"))).toBe(false);
    c = capture();
    expect(await runCli(["setup", "claude", "--apply", "--home", home, "--command", "osnova"], c.io)).toBe(0);
    expect(JSON.parse(await fs.readFile(at(".claude.json"), "utf8")).mcpServers.osnova.command).toBe("osnova");
    expect(Object.keys(JSON.parse(await fs.readFile(at(".claude", "settings.json"), "utf8")).hooks).sort()).toEqual(["SessionStart", "Stop", "UserPromptSubmit"]);
    expect(await fs.readFile(at(".claude", "skills", "osnova", "SKILL.md"), "utf8")).toContain("osnova_settle");
    c = capture();
    expect(await runCli(["setup", "claude", "--apply", "--home", home, "--command", "osnova"], c.io)).toBe(0);
    expect(c.out.join("\n")).not.toMatch(/, (create|append|update),/);
  });
});

describe("osnova setup agents", () => {
  it("sets up only the AGENTS.md harnesses that are installed, plus one shared skill", async () => {
    for (const dir of [[".codex"], [".config", "kilo"], [".pi", "agent"]]) await fs.mkdir(at(...dir), { recursive: true });
    const c = capture();
    expect(await runCli(["setup", "agents", "--apply", "--home", home, "--command", "osnova"], c.io)).toBe(0);
    const out = c.out.join("\n");
    expect(await fs.readFile(at(".codex", "config.toml"), "utf8")).toContain("[mcp_servers.osnova]");
    expect(await fs.readFile(at(".codex", "hooks.json"), "utf8")).toContain("--client codex");
    expect(existsSync(at(".config", "kilo", "plugins", "osnova.js"))).toBe(true);
    expect(existsSync(at(".pi", "agent", "extensions", "osnova.ts"))).toBe(true);
    expect(await fs.readFile(at(".pi", "agent", "mcp.json"), "utf8")).toContain("osnova");
    expect(await fs.readFile(at(".agents", "skills", "osnova", "SKILL.md"), "utf8")).toContain("osnova_settle");
    expect(out).toMatch(/osnova setup skipped: opencode, not installed/);
    expect(out).toMatch(/osnova setup skipped: cursor, not installed/);
    for (const absent of [[".config", "opencode"], [".cursor"], [".claude"], [".claude.json"]]) expect(existsSync(at(...absent))).toBe(false);
  });

  it("narrows to the harnesses named by --only and rejects a name outside the family", async () => {
    for (const dir of [[".codex"], [".config", "kilo"]]) await fs.mkdir(at(...dir), { recursive: true });
    expect(await runCli(["setup", "agents", "--apply", "--only", "codex", "--home", home, "--command", "osnova"], capture().io)).toBe(0);
    expect(existsSync(at(".codex", "config.toml"))).toBe(true);
    expect(existsSync(at(".config", "kilo", "plugins", "osnova.js"))).toBe(false);
    await expect(runCli(["setup", "agents", "--only", "claude-code", "--home", home], capture().io)).rejects.toThrow(/--only takes codex, opencode, kilo, pi, cursor/);
    await expect(runCli(["setup", "gemini", "--home", home], capture().io)).rejects.toThrow(/osnova setup takes claude or agents/);
  });

  it("keeps a skill or plugin file that differs and applies the rest, but stops on an MCP conflict", async () => {
    await fs.mkdir(at(".codex"), { recursive: true });
    await fs.mkdir(at(".agents", "skills", "osnova"), { recursive: true });
    await fs.writeFile(at(".agents", "skills", "osnova", "SKILL.md"), "# mine\n");
    const c = capture();
    expect(await runCli(["setup", "agents", "--apply", "--home", home, "--command", "osnova"], c.io)).toBe(0);
    expect(await fs.readFile(at(".agents", "skills", "osnova", "SKILL.md"), "utf8")).toBe("# mine\n");
    expect(c.out.join("\n")).toMatch(/osnova setup kept: skill, .*SKILL\.md differs from the shipped file/);
    expect(existsSync(at(".codex", "hooks.json"))).toBe(true);
    await fs.writeFile(at(".codex", "config.toml"), "[mcp_servers.osnova]\ncommand = \"something-else\"\n");
    await fs.rm(at(".codex", "hooks.json"));
    await expect(runCli(["setup", "agents", "--apply", "--home", home, "--command", "osnova"], capture().io)).rejects.toThrow(/nothing was written/);
    expect(existsSync(at(".codex", "hooks.json"))).toBe(false);
  });

  it("is checked by doctor like the Claude Code skill", async () => {
    await fs.mkdir(at(".agents", "skills", "osnova"), { recursive: true });
    await fs.writeFile(at(".agents", "skills", "osnova", "SKILL.md"), "# mine\n");
    const report = await doctor(home, { home });
    const check = report.checks.find((entry) => entry.id === "skill:agents");
    expect(check?.status).toBe("warning");
    expect(check?.message).toContain("osnova setup agents --apply");
  });
});

describe("setup family safety", () => {
  it("never writes a skill through a linked folder or a linked file, even when the file is missing", async () => {
    await fs.mkdir(at(".codex"), { recursive: true });
    const elsewhere = at("vault", "osnova");
    await fs.mkdir(elsewhere, { recursive: true });
    await fs.mkdir(at(".agents", "skills"), { recursive: true });
    await fs.symlink(elsewhere, at(".agents", "skills", "osnova"));
    const c = capture();
    expect(await runCli(["setup", "agents", "--apply", "--home", home, "--command", "osnova"], c.io)).toBe(0);
    expect(existsSync(path.join(elsewhere, "SKILL.md"))).toBe(false);
    expect(c.out.join("\n")).toMatch(/osnova setup kept: skill, .* is a link/);
    await fs.rm(at(".agents", "skills", "osnova"));
    await fs.mkdir(at(".agents", "skills", "osnova"));
    await fs.symlink(path.join(elsewhere, "SKILL.md"), at(".agents", "skills", "osnova", "SKILL.md"));
    expect(await runCli(["setup", "agents", "--apply", "--home", home, "--command", "osnova"], capture().io)).toBe(0);
    expect(existsSync(path.join(elsewhere, "SKILL.md"))).toBe(false);
  });

  it("never writes below a linked folder higher up, and keeps a link that points to itself", async () => {
    await fs.mkdir(at(".codex"), { recursive: true });
    const elsewhere = at("vault", "skills");
    await fs.mkdir(elsewhere, { recursive: true });
    await fs.mkdir(at(".agents"), { recursive: true });
    await fs.symlink(elsewhere, at(".agents", "skills"));
    let c = capture();
    expect(await runCli(["setup", "agents", "--apply", "--home", home, "--command", "osnova"], c.io)).toBe(0);
    expect(existsSync(path.join(elsewhere, "osnova", "SKILL.md"))).toBe(false);
    expect(c.out.join("\n")).toMatch(/osnova setup kept: skill, .*skills is a link/);
    await fs.rm(at(".agents", "skills"));
    await fs.mkdir(at(".agents", "skills", "osnova"), { recursive: true });
    await fs.symlink(at(".agents", "skills", "osnova", "SKILL.md"), at(".agents", "skills", "osnova", "SKILL.md"));
    c = capture();
    expect(await runCli(["setup", "agents", "--apply", "--home", home, "--command", "osnova"], c.io)).toBe(0);
    expect(c.out.join("\n")).toMatch(/osnova setup kept: skill, .*SKILL\.md is a link/);
    expect(existsSync(at(".codex", "hooks.json"))).toBe(true);
  });

  it("tells the user to repeat the exact command with --apply", async () => {
    await fs.mkdir(at(".codex"), { recursive: true });
    const c = capture();
    expect(await runCli(["setup", "agents", "--only", "codex", "--home", home], c.io)).toBe(0);
    expect(c.out.join("\n")).toContain("Repeat this command with --apply");
    expect(c.out.join("\n")).not.toContain("Run osnova setup agents --apply");
  });

  it("rejects --only outside setup agents and an empty --only", async () => {
    await expect(runCli(["setup", "--apply", "--client", "codex", "--only", "pi", "--home", home], capture().io)).rejects.toThrow(/--only belongs to osnova setup agents/);
    await expect(runCli(["setup", "claude", "--only", "codex", "--home", home], capture().io)).rejects.toThrow(/--only/);
    await expect(runCli(["setup", "agents", "--only", ",", "--home", home], capture().io)).rejects.toThrow(/--only takes/);
    expect(existsSync(at(".codex", "config.toml"))).toBe(false);
  });
});

describe("the below-home check", () => {
  it("treats every path under a filesystem root as below it", async () => {
    const { isBelowHome } = await import("../src/diagnostics/setup-apply.js");
    const root = path.parse(process.cwd()).root;
    expect(isBelowHome(root, path.join(root, "a", "b"))).toBe(true);
    expect(isBelowHome(at(), at(".agents", "skills"))).toBe(true);
    expect(isBelowHome(at(), at())).toBe(false);
    expect(isBelowHome(at(), path.dirname(home))).toBe(false);
    expect(isBelowHome(at(), `${home}-other`)).toBe(false);
    expect(isBelowHome(at(), at("..cache", "x"))).toBe(true);
  });
});
