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
    expect(text).not.toContain("osnova_thread");
    expect(text).toContain("not proof of absence");
    expect(text).toContain("an unresolved edge is a lead");
    const block = /<!-- osnova:start -->[\s\S]*<!-- osnova:end -->/.exec(text)?.[0] ?? "";
    expect(block.length).toBeLessThanOrEqual(480);
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

  it("repoints osnova hooks at this install, removes hooks it cannot run and duplicates, and leaves other hooks alone", async () => {
    const old = "node /opt/osnova-strict/dist/bin.js";
    const settingsPath = path.join(home, ".claude", "settings.json");
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify({
      theme: "dark",
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: `${old} hook session`, timeout: 7 }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: `${old} hook prompt`, timeout: 15 }] }, { hooks: [{ type: "command", command: "osnova hook prompt", timeout: 15 }] }],
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "node other.js" }, { type: "command", command: `${old} hook gate`, timeout: 30 }] },
          { matcher: "*", hooks: [{ type: "command", command: `${old} hook reset`, timeout: 5 }] },
        ],
        PostToolUse: [{ matcher: "Grep|Bash", hooks: [{ type: "command", command: `${old} hook tool`, timeout: 10 }] }, { matcher: "*", hooks: [{ type: "command", command: `${old} hook mark`, timeout: 5 }] }],
        Stop: [{ hooks: [{ type: "command", command: `${old} hook stop`, timeout: 30 }] }],
      },
    }, null, 2));
    let c = capture();
    expect(await runCli(["setup", "--preview", "--hooks", "--home", home, "--command", "osnova"], c.io)).toBe(0);
    const preview = c.out.join("\n");
    expect(preview).toMatch(/hooks, update, .*settings\.json/);
    expect(preview).toMatch(/removed .*gate.*mark.*reset/);
    c = capture();
    expect(await runCli(["setup", "--apply", "--hooks", "--home", home, "--command", "osnova"], c.io)).toBe(0);
    expect(c.out.join("\n")).toMatch(/applied: hooks, update, .*settings\.json \(backup .*settings\.json\.bak-osnova-/);
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    expect(settings.theme).toBe("dark");
    expect(settings.hooks.SessionStart).toEqual([{ hooks: [{ type: "command", command: "osnova hook session", timeout: 7 }] }]);
    expect(settings.hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: "command", command: "osnova hook prompt", timeout: 15 }] }]);
    expect(settings.hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: "node other.js" }] }]);
    expect(settings.hooks.PostToolUse).toEqual([{ matcher: "Grep|Bash", hooks: [{ type: "command", command: "osnova hook tool", timeout: 10 }] }]);
    expect(settings.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: "osnova hook stop", timeout: 30 }] }]);
    c = capture();
    expect(await runCli(["setup", "--apply", "--hooks", "--home", home, "--command", "osnova"], c.io)).toBe(0);
    expect(c.out.join("\n")).toContain("hooks, unchanged");
  });

  it("never rewrites a shell-wrapped osnova hook or a foreign hook that only mentions osnova in its flags", async () => {
    const settingsPath = path.join(home, ".claude", "settings.json");
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    const wrapped = { type: "command", command: "bash -c \"cd ~ && node /opt/osnova-strict/dist/bin.js hook prompt\"" };
    const foreign = { type: "command", command: "other-tool hook gate --note osnova" };
    const shellGate = { type: "command", command: "sh -c 'node /opt/osnova-strict/dist/bin.js hook gate'" };
    await fs.writeFile(settingsPath, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [wrapped] }], PreToolUse: [{ hooks: [foreign, shellGate] }] } }));
    expect(await runCli(["setup", "--apply", "--hooks", "--home", home, "--command", "osnova"], capture().io)).toBe(0);
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    expect(settings.hooks.UserPromptSubmit).toEqual([{ hooks: [wrapped] }]);
    expect(settings.hooks.PreToolUse).toEqual([{ hooks: [foreign, shellGate] }]);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe("osnova hook session");
  });

  it("repoints Codex hooks and keeps their client flag", async () => {
    const hooksPath = path.join(home, ".codex", "hooks.json");
    await fs.mkdir(path.dirname(hooksPath), { recursive: true });
    await fs.writeFile(hooksPath, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node /opt/osnova-strict/dist/bin.js hook stop --client codex", timeout: 30 }] }], PreToolUse: [{ hooks: [{ type: "command", command: "node /opt/osnova-strict/dist/bin.js hook gate --client codex" }] }] } }));
    const c = capture();
    expect(await runCli(["setup", "--apply", "--hooks", "--client", "codex", "--home", home, "--command", "osnova"], c.io)).toBe(0);
    expect(c.out.join("\n")).toContain("open /hooks in Codex");
    const codex = JSON.parse(await fs.readFile(hooksPath, "utf8"));
    expect(codex.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: "osnova hook stop --client codex", timeout: 30 }] }]);
    expect(codex.hooks.PreToolUse).toBeUndefined();
    expect(codex.hooks.SessionStart[0].hooks[0].command).toBe("osnova hook session --client codex");
  });

  it("refuses to write when the MCP entry conflicts, and writes nothing else either", async () => {
    await fs.writeFile(path.join(home, ".claude.json"), '{ "mcpServers": { "osnova": { "command": "elsewhere", "args": ["mcp"] } } }\n');
    const c = capture();
    await expect(runCli(["setup", "--apply", "--client", "claude-code", "--hooks", "--home", home], c.io)).rejects.toThrow(/conflicts with the proposal; nothing was written/);
    await expect(fs.access(path.join(home, ".claude", "settings.json"))).rejects.toThrow();
  });
});

describe("doctor client version check", () => {
  it("warns when a configured hook or MCP command resolves to another version, ok when it matches", async () => {
    const { OSNOVA_VERSION } = await import("../src/version.js");
    const install = async (name: string, version: string): Promise<string> => {
      await fs.mkdir(path.join(home, name), { recursive: true });
      await fs.writeFile(path.join(home, name, "package.json"), JSON.stringify({ name: "@getdomovoi/osnova", version }));
      const bin = path.join(home, name, "bin.js"); await fs.writeFile(bin, "process.exit(1);\n");
      return bin;
    };
    const same = await install("same", OSNOVA_VERSION);
    const other = await install("other", "0.0.1");
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

describe("hooks for Codex and Cursor", () => {
  it("writes ~/.codex/hooks.json with additionalContext-shaped hooks and ~/.cursor/hooks.json with a stop follow-up", async () => {
    let c = capture();
    expect(await runCli(["setup", "--apply", "--hooks", "--client", "codex", "--home", home], c.io)).toBe(0);
    expect(c.out.join("\n")).toContain("open /hooks in Codex");
    const codex = JSON.parse(await fs.readFile(path.join(home, ".codex", "hooks.json"), "utf8"));
    expect(codex.hooks.UserPromptSubmit[0].hooks[0].command).toBe("osnova hook prompt --client codex");
    expect(codex.hooks.Stop[0].hooks[0].command).toBe("osnova hook stop --client codex");
    c = capture();
    expect(await runCli(["setup", "--apply", "--hooks", "--client", "cursor", "--home", home], c.io)).toBe(0);
    const cursor = JSON.parse(await fs.readFile(path.join(home, ".cursor", "hooks.json"), "utf8"));
    expect(cursor.version).toBe(1);
    expect(cursor.hooks.stop).toEqual([{ command: "osnova hook stop --client cursor", timeout: 30 }]);
    c = capture();
    expect(await runCli(["setup", "--apply", "--hooks", "--client", "cursor", "--home", home], c.io)).toBe(0);
    expect(c.out.join("\n")).toContain("hooks, unchanged");
  });
});

describe("the Claude Code skill", () => {
  it("copies SKILL.md once into ~/.claude/skills/osnova and refuses to overwrite a different one", async () => {
    let c = capture();
    expect(await runCli(["setup", "--apply", "--skill", "--home", home], c.io)).toBe(0);
    const target = path.join(home, ".claude", "skills", "osnova", "SKILL.md");
    const text = await fs.readFile(target, "utf8");
    expect(text.replace(/\r\n/g, "\n").startsWith("---\nname: osnova\n")).toBe(true);
    expect(text).toContain("osnova_settle");
    expect(c.out.join("\n")).toMatch(/skill, create, .*SKILL\.md/);
    c = capture();
    expect(await runCli(["setup", "--apply", "--client", "claude-code", "--skill", "--home", home], c.io)).toBe(0);
    expect(c.out.join("\n")).toContain("skill, unchanged");
    await fs.writeFile(target, "# mine\n");
    c = capture();
    await expect(runCli(["setup", "--apply", "--skill", "--home", home], c.io)).rejects.toThrow(/nothing was written/);
    expect(await fs.readFile(target, "utf8")).toBe("# mine\n");
    await expect(runCli(["setup", "--apply", "--client", "codex", "--skill", "--home", home], capture().io)).rejects.toThrow(/--skill supports --client claude-code/);
  });
});

describe("doctor integration file checks", () => {
  it("reports installed plugin and skill files that match or differ from the shipped ones", async () => {
    const c = capture();
    let report = await doctor(process.cwd(), { home });
    expect(report.checks.find((check) => check.id === "integrations")?.status).toBe("ok");
    expect(await runCli(["setup", "--apply", "--client", "opencode", "--plugin", "--home", home], c.io)).toBe(0);
    expect(await runCli(["setup", "--apply", "--skill", "--home", home], c.io)).toBe(0);
    report = await doctor(process.cwd(), { home });
    expect(report.checks.find((check) => check.id === "plugin:opencode")?.status).toBe("ok");
    expect(report.checks.find((check) => check.id === "skill:claude-code")?.status).toBe("ok");
    expect(report.checks.find((check) => check.id === "plugin:pi")).toBeUndefined();
    await fs.appendFile(path.join(home, ".claude", "skills", "osnova", "SKILL.md"), "\nlocal note\n");
    report = await doctor(process.cwd(), { home });
    const skill = report.checks.find((check) => check.id === "skill:claude-code");
    expect(skill?.status).toBe("warning");
    expect(skill?.message).toContain("osnova setup --apply --skill");
  });
});

describe("plugins for OpenCode, Kilo and Pi", () => {
  it("copies the shipped plugin or extension file once and refuses to overwrite a different one", async () => {
    let c = capture();
    expect(await runCli(["setup", "--apply", "--client", "opencode", "--plugin", "--home", home], c.io)).toBe(0);
    const target = path.join(home, ".config", "opencode", "plugins", "osnova.js");
    const text = await fs.readFile(target, "utf8");
    expect(text).toContain("experimental.chat.system.transform");
    expect(c.out.join("\n")).toMatch(/plugin, create, .*plugins[\\/]osnova\.js/);
    c = capture();
    expect(await runCli(["setup", "--apply", "--client", "opencode", "--plugin", "--home", home], c.io)).toBe(0);
    expect(c.out.join("\n")).toContain("plugin, unchanged");
    await fs.writeFile(target, "// mine\n");
    c = capture();
    await expect(runCli(["setup", "--apply", "--client", "opencode", "--plugin", "--home", home], c.io)).rejects.toThrow(/nothing was written/);
    expect(await fs.readFile(target, "utf8")).toBe("// mine\n");
    c = capture();
    expect(await runCli(["setup", "--apply", "--client", "pi", "--plugin", "--home", home], c.io)).toBe(0);
    expect(await fs.readFile(path.join(home, ".pi", "agent", "extensions", "osnova.ts"), "utf8")).toContain("before_agent_start");
    c = capture();
    expect(await runCli(["setup", "--apply", "--client", "kilo", "--plugin", "--home", home], c.io)).toBe(0);
    expect(await fs.readFile(path.join(home, ".config", "kilo", "plugins", "osnova.js"), "utf8")).toContain("chat.message");
  });

  it.skipIf(process.platform === "win32")("the OpenCode plugin appends starting points to the user message and the contract to the system prompt", async () => {
    const fake = path.join(home, "fake-osnova.mjs");
    await fs.writeFile(fake, "let raw=''; process.stdin.on('data',(d)=>raw+=d); process.stdin.on('end',()=>{ const e=process.argv[3]; const p=JSON.parse(raw||'{}'); process.stdout.write(e==='session'?'CONTRACT':e==='prompt'?`POINTS for ${p.prompt}`:''); });\n");
    const wrapper = path.join(home, "osnova-bin.sh");
    await fs.writeFile(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} "$@"\n`, { mode: 0o755 });
    process.env.OSNOVA_BIN = wrapper;
    try {
      const { OsnovaPlugin } = await import("../integrations/opencode/osnova.js");
      const hooks = await OsnovaPlugin({ directory: home, worktree: home });
      const system: string[] = [];
      await hooks["experimental.chat.system.transform"]({}, { system });
      expect(system).toEqual(["CONTRACT"]);
      const parts = [{ type: "text", text: "why is total wrong" }];
      await hooks["chat.message"]({}, { message: {}, parts });
      expect(parts[0]!.text).toBe("why is total wrong\n\nPOINTS for why is total wrong");
    } finally { delete process.env.OSNOVA_BIN; }
  });
});
