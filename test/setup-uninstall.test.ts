import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../src/cli/cli.js";

let home: string;
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-uninstall-")); });
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });
function capture() { const out: string[] = []; return { out, io: { stdout: (t: string) => out.push(t), stderr: (t: string) => out.push(`ERR ${t}`) } }; }
const at = (...parts: string[]): string => path.join(home, ...parts);
async function write(file: string, text: string): Promise<void> { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); }
async function snapshot(files: readonly string[]): Promise<Map<string, string>> {
  return new Map(await Promise.all(files.map(async (file) => [file, await fs.readFile(file, "utf8")] as const)));
}

// Configs as the hosts write them, holding other servers, other hooks and comments that setup must not disturb.
const claudeJson = `${JSON.stringify({ numStartups: 4, mcpServers: { other: { command: "other-server", args: [] } }, projects: { "/w": { mcpServers: {} } } }, null, 2)}\n`;
const claudeSettings = `${JSON.stringify({ model: "sonnet", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-guard" }] }] } }, null, 2)}\n`;
const codexToml = "# my codex config\nmodel = \"gpt\"\n\n[mcp_servers.other]\ncommand = \"other\"\nargs = []\n";
const kiloJsonc = "{\n  // my kilo config\n  \"mcp\": {\n    \"other\": { \"type\": \"local\", \"command\": [\"other\"] }\n  }\n}\n";
const piMcp = `${JSON.stringify({ mcpServers: { other: { command: "other", args: [] } } }, null, 2)}\n`;
const cursorMcp = `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`;

describe("osnova setup --uninstall", () => {
  it("returns every existing Claude Code file to its bytes before setup, and removes the skill it installed", async () => {
    await write(at(".claude.json"), claudeJson);
    await write(at(".claude", "settings.json"), claudeSettings);
    const before = await snapshot([at(".claude.json"), at(".claude", "settings.json")]);
    expect(await runCli(["setup", "claude", "--apply", "--home", home, "--command", "osnova"], capture().io)).toBe(0);
    expect(await fs.readFile(at(".claude.json"), "utf8")).not.toBe(claudeJson);
    const c = capture();
    expect(await runCli(["setup", "claude", "--uninstall", "--apply", "--home", home], c.io)).toBe(0);
    for (const [file, text] of before) expect(await fs.readFile(file, "utf8")).toBe(text);
    expect(existsSync(at(".claude", "skills", "osnova"))).toBe(false);
    expect(c.out.join("\n")).toMatch(/osnova setup applied: claude-code, remove, .*\.claude\.json \(backup /);
    expect(c.out.join("\n")).toMatch(/osnova setup applied: skill, delete, .*SKILL\.md \(backup /);
  });

  it("returns every existing file of the AGENTS.md harnesses to its bytes and deletes the files setup added", async () => {
    await write(at(".codex", "config.toml"), codexToml);
    await write(at(".config", "kilo", "kilo.jsonc"), kiloJsonc);
    await write(at(".pi", "agent", "mcp.json"), piMcp);
    await write(at(".cursor", "mcp.json"), cursorMcp);
    const existing = [at(".codex", "config.toml"), at(".config", "kilo", "kilo.jsonc"), at(".pi", "agent", "mcp.json"), at(".cursor", "mcp.json")];
    const before = await snapshot(existing);
    expect(await runCli(["setup", "agents", "--apply", "--home", home, "--command", "osnova"], capture().io)).toBe(0);
    expect(await runCli(["setup", "agents", "--uninstall", "--apply", "--home", home], capture().io)).toBe(0);
    for (const [file, text] of before) expect(await fs.readFile(file, "utf8")).toBe(text);
    for (const added of [[".config", "kilo", "plugins", "osnova.js"], [".pi", "agent", "extensions", "osnova.ts"], [".agents", "skills", "osnova"]]) expect(existsSync(at(...added))).toBe(false);
    for (const hooks of [[".codex", "hooks.json"], [".cursor", "hooks.json"]]) expect(await fs.readFile(at(...hooks), "utf8")).not.toMatch(/osnova/);
  });

  it("previews without writing anything", async () => {
    await write(at(".claude.json"), claudeJson);
    expect(await runCli(["setup", "claude", "--apply", "--home", home, "--command", "osnova"], capture().io)).toBe(0);
    const installed = await fs.readFile(at(".claude.json"), "utf8");
    const c = capture();
    expect(await runCli(["setup", "claude", "--uninstall", "--home", home], c.io)).toBe(0);
    expect(c.out.join("\n")).toMatch(/osnova setup preview: claude-code, remove, /);
    expect(c.out.join("\n")).toContain("Repeat this command with --apply");
    expect(await fs.readFile(at(".claude.json"), "utf8")).toBe(installed);
    expect(existsSync(at(".claude", "skills", "osnova", "SKILL.md"))).toBe(true);
  });

  it("keeps what is not osnova's own or was changed, and removes the rest", async () => {
    // An "osnova" MCP entry that launches something else, a shell-wrapped osnova hook, an edited plugin and a
    // skill folder reached through a link all stay; the plain osnova hook goes.
    await write(at(".claude.json"), `${JSON.stringify({ mcpServers: { osnova: { command: "my-own-thing", args: [] } } }, null, 2)}\n`);
    await write(at(".claude", "settings.json"), `${JSON.stringify({ hooks: {
      Stop: [{ hooks: [{ type: "command", command: "osnova hook stop" }] }],
      SessionStart: [{ hooks: [{ type: "command", command: "bash -c 'osnova hook session'" }] }],
    } }, null, 2)}\n`);
    await fs.mkdir(at(".config", "kilo"), { recursive: true });
    await write(at(".config", "kilo", "plugins", "osnova.js"), "// my edited plugin\n");
    const vault = at("vault", "osnova");
    await write(path.join(vault, "SKILL.md"), "# my skill\n");
    await fs.mkdir(at(".agents", "skills"), { recursive: true });
    await fs.symlink(vault, at(".agents", "skills", "osnova"));
    let c = capture();
    expect(await runCli(["setup", "claude", "--uninstall", "--apply", "--home", home], c.io)).toBe(0);
    const claude = c.out.join("\n");
    expect(JSON.parse(await fs.readFile(at(".claude.json"), "utf8")).mcpServers.osnova.command).toBe("my-own-thing");
    const hooks = JSON.parse(await fs.readFile(at(".claude", "settings.json"), "utf8")).hooks;
    expect(hooks.Stop).toBeUndefined();
    expect(hooks.SessionStart[0].hooks[0].command).toBe("bash -c 'osnova hook session'");
    expect(claude).toMatch(/osnova setup kept: mcp, .*does not launch osnova/);
    expect(claude).toMatch(/osnova setup kept: hooks, .*shell/);
    c = capture();
    expect(await runCli(["setup", "agents", "--uninstall", "--apply", "--home", home], c.io)).toBe(0);
    expect(await fs.readFile(at(".config", "kilo", "plugins", "osnova.js"), "utf8")).toBe("// my edited plugin\n");
    expect(await fs.readFile(path.join(vault, "SKILL.md"), "utf8")).toBe("# my skill\n");
    expect((await fs.lstat(at(".agents", "skills", "osnova"))).isSymbolicLink()).toBe(true);
    expect(c.out.join("\n")).toMatch(/osnova setup kept: plugin, /);
    expect(c.out.join("\n")).toMatch(/osnova setup kept: skill, .*link/);
  });

  it("removes the instructions block from a file it is pointed at", async () => {
    const agents = at("repo", "AGENTS.md");
    await write(agents, "# Repo rules\n\nBe careful.\n");
    const before = await fs.readFile(agents, "utf8");
    expect(await runCli(["setup", "--apply", "--client", "claude-code", "--instructions", agents, "--home", home, "--command", "osnova"], capture().io)).toBe(0);
    expect(await fs.readFile(agents, "utf8")).toContain("<!-- osnova:start -->");
    expect(await runCli(["setup", "claude", "--uninstall", "--apply", "--instructions", agents, "--home", home], capture().io)).toBe(0);
    expect(await fs.readFile(agents, "utf8")).toBe(before);
  });

  it("says so when there is nothing to remove", async () => {
    const c = capture();
    expect(await runCli(["setup", "claude", "--uninstall", "--apply", "--home", home], c.io)).toBe(0);
    expect(c.out.join("\n")).toContain("osnova setup claude --uninstall: nothing to remove.");
  });
});

describe("removing the MCP entry from text", () => {
  it("cuts a first entry with its comma, keeps comments elsewhere, and leaves a project's own entry", async () => {
    const { previewRemoval } = await import("../src/diagnostics/setup-preview.js");
    await write(at(".config", "kilo", "kilo.jsonc"), "{\n  \"mcp\": {\n    \"osnova\": {\n      // mine\n      \"type\": \"local\", \"command\": [\"osnova\", \"mcp\"]\n    },\n    \"other\": { \"type\": \"local\" } // keep me\n  }\n}\n");
    expect((await previewRemoval("kilo", { home })).merged).toBe("{\n  \"mcp\": {\n    \"other\": { \"type\": \"local\" } // keep me\n  }\n}\n");
    const claude = `${JSON.stringify({ mcpServers: { osnova: { command: "osnova", args: ["mcp"] } }, projects: { "/w": { mcpServers: { osnova: { command: "osnova", args: ["mcp"] } } } } }, null, 2)}\n`;
    await write(at(".claude.json"), claude);
    const merged = JSON.parse((await previewRemoval("claude-code", { home })).merged);
    expect(merged.mcpServers).toEqual({});
    expect(merged.projects["/w"].mcpServers.osnova.command).toBe("osnova");
  });

  it("removes the osnova table and its tool tables from between other tables", async () => {
    const { previewRemoval } = await import("../src/diagnostics/setup-preview.js");
    const before = "[mcp_servers.a]\ncommand = \"a\"\n\n";
    const after = "[mcp_servers.b]\ncommand = \"b\"\n";
    await write(at(".codex", "config.toml"), `${before}[mcp_servers.osnova]\ncommand = "osnova"\nargs = ["mcp", "--watch"]\n\n[mcp_servers.osnova.tools.osnova_ground]\napproval_mode = "approve"\n\n${after}`);
    expect((await previewRemoval("codex", { home })).merged).toBe(`${before}${after}`);
  });
});

describe("review round one", () => {
  it("never treats a command that only mentions osnova as osnova's", async () => {
    const { isOsnovaLauncher } = await import("../src/diagnostics/setup-preview.js");
    expect(isOsnovaLauncher(["echo", "osnova"])).toBe(false);
    expect(isOsnovaLauncher(["osnova"])).toBe(true);
    expect(isOsnovaLauncher(["npx", "-y", "@getdomovoi/osnova"])).toBe(true);
    expect(isOsnovaLauncher(["/opt/homebrew/bin/node", "/opt/homebrew/lib/node_modules/@getdomovoi/osnova/dist/bin.js"])).toBe(true);
    await write(at(".claude.json"), `${JSON.stringify({ mcpServers: { osnova: { command: "echo", args: ["osnova", "mcp"] } } }, null, 2)}\n`);
    await write(at(".claude", "settings.json"), `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo osnova hook stop" }] }] } }, null, 2)}\n`);
    const before = await snapshot([at(".claude.json"), at(".claude", "settings.json")]);
    expect(await runCli(["setup", "claude", "--uninstall", "--apply", "--home", home], capture().io)).toBe(0);
    for (const [file, text] of before) expect(await fs.readFile(file, "utf8")).toBe(text);
  });

  it("does not edit a config reached through a link", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-uninstall-dots-"));
    try {
      await write(path.join(outside, "claude", "settings.json"), `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "osnova hook stop" }] }] } }, null, 2)}\n`);
      await fs.symlink(path.join(outside, "claude"), at(".claude"));
      const before = await fs.readFile(path.join(outside, "claude", "settings.json"), "utf8");
      const c = capture();
      expect(await runCli(["setup", "claude", "--uninstall", "--apply", "--home", home], c.io)).toBe(0);
      expect(await fs.readFile(path.join(outside, "claude", "settings.json"), "utf8")).toBe(before);
      expect(c.out.join("\n")).toMatch(/osnova setup kept: hooks, .*link/);
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
  });

  it("keeps the comment above the next entry or table", async () => {
    const { previewRemoval } = await import("../src/diagnostics/setup-preview.js");
    await write(at(".config", "kilo", "kilo.jsonc"), "{\n  \"mcp\": {\n    \"osnova\": { \"type\": \"local\", \"command\": [\"osnova\", \"mcp\"] },\n    // about other\n    \"other\": { \"type\": \"local\" }\n  }\n}\n");
    expect((await previewRemoval("kilo", { home })).merged).toBe("{\n  \"mcp\": {\n    // about other\n    \"other\": { \"type\": \"local\" }\n  }\n}\n");
    await write(at(".codex", "config.toml"), "[mcp_servers.osnova]\ncommand = \"osnova\"\nargs = [\"mcp\"]\n\n# about b\n[mcp_servers.b]\ncommand = \"b\"\n");
    expect((await previewRemoval("codex", { home })).merged).toBe("# about b\n[mcp_servers.b]\ncommand = \"b\"\n");
  });

  it("keeps the shared skill while an installed harness outside --only still reads it", async () => {
    for (const dir of [[".codex"], [".cursor"]]) await fs.mkdir(at(...dir), { recursive: true });
    expect(await runCli(["setup", "agents", "--apply", "--home", home, "--command", "osnova"], capture().io)).toBe(0);
    const c = capture();
    expect(await runCli(["setup", "agents", "--uninstall", "--apply", "--only", "cursor", "--home", home], c.io)).toBe(0);
    expect(existsSync(at(".agents", "skills", "osnova", "SKILL.md"))).toBe(true);
    expect(c.out.join("\n")).toMatch(/osnova setup kept: skill, .*codex/);
    expect(await runCli(["setup", "agents", "--uninstall", "--apply", "--home", home], capture().io)).toBe(0);
    expect(existsSync(at(".agents", "skills", "osnova"))).toBe(false);
  });

  it("keeps CRLF line endings through setup and uninstall", async () => {
    const crlf = claudeSettings.replace(/\n/g, "\r\n");
    await write(at(".claude", "settings.json"), crlf);
    await write(at(".claude.json"), claudeJson.replace(/\n/g, "\r\n"));
    expect(await runCli(["setup", "claude", "--apply", "--home", home, "--command", "osnova"], capture().io)).toBe(0);
    expect(await fs.readFile(at(".claude", "settings.json"), "utf8")).not.toMatch(/[^\r]\n/);
    expect(await runCli(["setup", "claude", "--uninstall", "--apply", "--home", home], capture().io)).toBe(0);
    expect(await fs.readFile(at(".claude", "settings.json"), "utf8")).toBe(crlf);
    expect(await fs.readFile(at(".claude.json"), "utf8")).toBe(claudeJson.replace(/\n/g, "\r\n"));
  });

  it("stops on duplicate osnova keys instead of guessing which to cut", async () => {
    const text = "{\n  \"mcpServers\": {\n    \"osnova\": { \"command\": \"mine\", \"args\": [] },\n    \"osnova\": { \"command\": \"osnova\", \"args\": [\"mcp\"] }\n  }\n}\n";
    await write(at(".claude.json"), text);
    const c = capture();
    expect(await runCli(["setup", "claude", "--uninstall", "--apply", "--home", home], c.io)).toBe(0);
    expect(await fs.readFile(at(".claude.json"), "utf8")).toBe(text);
    expect(c.out.join("\n")).toMatch(/osnova setup kept: mcp, .*more than one osnova/);
  });

  it("keeps an instructions block that was edited, and cuts an unedited one exactly", async () => {
    const edited = at("repo", "EDITED.md");
    await write(edited, "# Rules\n\n<!-- osnova:start -->\n## Osnova\nmy own notes\n<!-- osnova:end -->\n");
    const exact = at("repo", "AGENTS.md");
    await write(exact, "# Rules\n\n\n");
    expect(await runCli(["setup", "--apply", "--client", "claude-code", "--instructions", exact, "--home", home, "--command", "osnova"], capture().io)).toBe(0);
    const installed = await fs.readFile(exact, "utf8");
    const c = capture();
    expect(await runCli(["setup", "claude", "--uninstall", "--apply", "--instructions", edited, "--home", home], c.io)).toBe(0);
    expect(await fs.readFile(edited, "utf8")).toContain("my own notes");
    expect(c.out.join("\n")).toMatch(/osnova setup kept: instructions, .*edited/);
    expect(await runCli(["setup", "claude", "--uninstall", "--apply", "--instructions", exact, "--home", home], capture().io)).toBe(0);
    expect(await fs.readFile(exact, "utf8")).toBe(installed.slice(0, installed.indexOf("\n\n<!-- osnova:start -->")) + "\n");
  });

  it.skipIf(process.platform === "win32")("reports what it already changed when a later step fails", async () => {
    await write(at(".claude.json"), claudeJson);
    expect(await runCli(["setup", "claude", "--apply", "--home", home, "--command", "osnova"], capture().io)).toBe(0);
    await fs.chmod(at(".claude", "skills", "osnova"), 0o555);
    const c = capture();
    try {
      await expect(runCli(["setup", "claude", "--uninstall", "--apply", "--home", home], c.io)).rejects.toThrow();
      expect(c.out.join("\n")).toMatch(/osnova setup applied: claude-code, remove, .*\(backup /);
    } finally { await fs.chmod(at(".claude", "skills", "osnova"), 0o755); }
  });
});

describe("review round two", () => {
  it("does not edit an instructions file reached through a link", async () => {
    const real = at("repo", "AGENTS.md");
    await write(real, "# Rules\n");
    expect(await runCli(["setup", "--apply", "--client", "claude-code", "--instructions", real, "--home", home, "--command", "osnova"], capture().io)).toBe(0);
    const installed = await fs.readFile(real, "utf8");
    await fs.symlink(real, at("repo", "CLAUDE.md"));
    const c = capture();
    expect(await runCli(["setup", "claude", "--uninstall", "--apply", "--instructions", at("repo", "CLAUDE.md"), "--home", home], c.io)).toBe(0);
    expect(await fs.readFile(real, "utf8")).toBe(installed);
    expect(c.out.join("\n")).toMatch(/osnova setup kept: instructions, .*link/);
  });

  it("does not count a runtime that evaluates code as osnova's launch", async () => {
    const { isOsnovaLauncher } = await import("../src/diagnostics/setup-preview.js");
    expect(isOsnovaLauncher(["node", "-e", "osnova"])).toBe(false);
    expect(isOsnovaLauncher(["node", "--eval", "osnova"])).toBe(false);
    expect(isOsnovaLauncher(["node", "--enable-source-maps", "/x/osnova/dist/bin.js"])).toBe(true);
  });

  it("stops on a file with two MCP root objects", async () => {
    const text = "{\n  \"mcpServers\": { \"osnova\": { \"command\": \"mine\", \"args\": [] } },\n  \"mcpServers\": { \"osnova\": { \"command\": \"osnova\", \"args\": [\"mcp\"] } }\n}\n";
    await write(at(".claude.json"), text);
    const c = capture();
    expect(await runCli(["setup", "claude", "--uninstall", "--apply", "--home", home], c.io)).toBe(0);
    expect(await fs.readFile(at(".claude.json"), "utf8")).toBe(text);
    expect(c.out.join("\n")).toMatch(/osnova setup kept: mcp, .*more than one/);
  });

  it("does not count a quoted echo of an osnova hook as that hook", async () => {
    await write(at(".claude", "settings.json"), `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo 'osnova hook stop'" }] }] } }, null, 2)}\n`);
    expect(await runCli(["setup", "--apply", "--hooks", "--home", home, "--command", "osnova"], capture().io)).toBe(0);
    const commands = JSON.parse(await fs.readFile(at(".claude", "settings.json"), "utf8")).hooks.Stop.flatMap((group: { hooks: { command: string }[] }) => group.hooks.map((hook) => hook.command));
    expect(commands).toContain("osnova hook stop");
  });

  it.skipIf(process.platform === "win32")("reports a deleted skill even when moving its backup fails", async () => {
    expect(await runCli(["setup", "claude", "--apply", "--home", home, "--command", "osnova"], capture().io)).toBe(0);
    await fs.chmod(at(".claude", "skills"), 0o555);
    const c = capture();
    try {
      await expect(runCli(["setup", "claude", "--uninstall", "--apply", "--home", home], c.io)).rejects.toThrow();
      expect(c.out.join("\n")).toMatch(/osnova setup applied: skill, delete, .*SKILL\.md \(backup /);
    } finally { await fs.chmod(at(".claude", "skills"), 0o755); }
  });
});

describe("review round three", () => {
  it("does not count a shell that only prints an osnova hook, but still counts one that runs it", async () => {
    await write(at(".claude", "settings.json"), `${JSON.stringify({ hooks: {
      Stop: [{ hooks: [{ type: "command", command: "bash -c 'echo osnova hook stop'" }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "bash -c \"cd ~ && node /opt/osnova-strict/dist/bin.js hook prompt\"" }] }],
    } }, null, 2)}\n`);
    expect(await runCli(["setup", "--apply", "--hooks", "--home", home, "--command", "osnova"], capture().io)).toBe(0);
    const hooks = JSON.parse(await fs.readFile(at(".claude", "settings.json"), "utf8")).hooks;
    const commands = (event: string): string[] => hooks[event].flatMap((group: { hooks: { command: string }[] }) => group.hooks.map((hook) => hook.command));
    expect(commands("Stop")).toContain("osnova hook stop");
    expect(commands("UserPromptSubmit")).not.toContain("osnova hook prompt");
  });
});

describe("review round four", () => {
  it("splits a shell script only outside quotes", async () => {
    const { shellWrappedOsnovaHook } = await import("../src/diagnostics/setup-preview.js");
    expect(shellWrappedOsnovaHook("bash -c 'echo \"text; osnova hook stop \"'")).toBeUndefined();
    expect(shellWrappedOsnovaHook("bash -c \"echo 'a && osnova hook stop'\"")).toBeUndefined();
    expect(shellWrappedOsnovaHook("bash -c 'cd ~; osnova hook stop'")).toBe("stop");
    expect(shellWrappedOsnovaHook("bash -c \"cd ~ && node /opt/osnova-strict/dist/bin.js hook prompt\"")).toBe("prompt");
  });
});
