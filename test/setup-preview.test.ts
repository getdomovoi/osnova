import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { previewSetup, setupClients } from "../src/diagnostics/setup-preview.js";
import { runCli } from "../src/cli/cli.js";

let home: string;
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-setup-")); });
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });

async function snapshot(): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full); else out.push(`${path.relative(home, full)}:${await fs.readFile(full, "utf8")}`);
    }
  }
  await walk(home);
  return out.sort();
}

describe("setup preview", () => {
  it("lists every documented client with a config path under the home directory", () => {
    expect(setupClients.map((client) => client.id)).toEqual(["claude-code", "codex", "opencode", "kilo", "cursor", "pi"]);
    for (const client of setupClients) expect(client.configPath(home).startsWith(home)).toBe(true);
  });

  it("proposes a new file when the client has no config yet", async () => {
    const preview = await previewSetup("cursor", { home });
    expect(preview).toMatchObject({ client: "cursor", action: "create", path: path.join(home, ".cursor", "mcp.json") });
    expect(preview.diff).toContain("+  \"mcpServers\": {");
    expect(preview.diff).toContain("+    \"osnova\": {");
    expect(preview.diff).toContain("+      \"command\": \"osnova\",");
    expect(await snapshot()).toEqual([]);
  });

  it("inserts into an existing mcpServers object without touching other entries or comments", async () => {
    const file = path.join(home, ".cursor", "mcp.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const original = '{\n  // keep me\n  "mcpServers": {\n    "other": { "command": "other" }\n  },\n  "theme": "dark"\n}\n';
    await fs.writeFile(file, original);
    const before = await snapshot();
    const preview = await previewSetup("cursor", { home });
    expect(preview.action).toBe("append");
    expect(preview.diff).toContain("-    \"other\": { \"command\": \"other\" }\n+    \"other\": { \"command\": \"other\" },\n+    \"osnova\": {");
    expect(preview.diff).not.toContain("-  // keep me");
    expect(preview.merged).toContain("// keep me");
    expect(preview.merged).toContain('"theme": "dark"');
    expect(JSON.parse(preview.merged.replace(/^\s*\/\/.*$/gm, ""))).toMatchObject({ mcpServers: { other: { command: "other" }, osnova: { command: "osnova", args: ["mcp"] } }, theme: "dark" });
    expect(await snapshot()).toEqual(before);
  });

  it("adds the root key when the file has none", async () => {
    const file = path.join(home, ".claude.json");
    await fs.writeFile(file, '{\n  "numStartups": 3\n}\n');
    const preview = await previewSetup("claude-code", { home });
    expect(preview.action).toBe("append");
    expect(JSON.parse(preview.merged)).toEqual({ numStartups: 3, mcpServers: { osnova: { command: "osnova", args: ["mcp"] } } });
  });

  it("reports unchanged, repoints an osnova entry from another install, and refuses one that does not launch osnova", async () => {
    const file = path.join(home, ".pi", "agent", "mcp.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ mcpServers: { osnova: { command: "osnova", args: ["mcp"] } } }, null, 2));
    expect((await previewSetup("pi", { home })).action).toBe("unchanged");
    await fs.writeFile(file, JSON.stringify({ mcpServers: { osnova: { command: "/old/osnova", args: ["mcp", "--watch"], env: { A: "1" } } } }, null, 2));
    const update = await previewSetup("pi", { home });
    expect(update.action).toBe("update");
    expect(update.diff).toContain('+      "command": "osnova",');
    expect(update.notice).toContain("repointed");
    expect(JSON.parse(update.merged)).toEqual({ mcpServers: { osnova: { command: "osnova", args: ["mcp", "--watch"], env: { A: "1" } } } });
    await fs.writeFile(file, JSON.stringify({ mcpServers: { osnova: { command: "elsewhere", args: ["mcp"] } } }, null, 2));
    const conflict = await previewSetup("pi", { home });
    expect(conflict.action).toBe("conflict");
    expect(conflict.diff).toBe("");
    expect(conflict.notice).toContain("does not launch osnova");
  });

  it("edits only the top-level entry in ~/.claude.json, never a project's", async () => {
    const file = path.join(home, ".claude.json");
    const project = '{\n  "projects": {\n    "/p": {\n      "mcpServers": {\n        "osnova": { "command": "node", "args": ["/p/osnova/bin.js", "mcp"] }\n      }\n    }\n  },\n';
    await fs.writeFile(file, `${project}  "mcpServers": {\n    "osnova": {\n      "type": "stdio",\n      "command": "node",\n      "args": ["/x/osnova-strict/dist/bin.js", "mcp", "--watch"],\n      "env": {}\n    }\n  },\n  "theme": "dark"\n}\n`);
    const update = await previewSetup("claude-code", { home });
    expect(update.action).toBe("update");
    expect(update.merged.startsWith(project)).toBe(true);
    expect(JSON.parse(update.merged)).toEqual({
      projects: { "/p": { mcpServers: { osnova: { command: "node", args: ["/p/osnova/bin.js", "mcp"] } } } },
      mcpServers: { osnova: { type: "stdio", command: "osnova", args: ["mcp", "--watch"], env: {} } },
      theme: "dark",
    });
    await fs.writeFile(file, `${project}  "mcpServers": {\n    "other": { "command": "other" }\n  }\n}\n`);
    const append = await previewSetup("claude-code", { home });
    expect(append.action).toBe("append");
    expect(JSON.parse(append.merged).projects).toEqual({ "/p": { mcpServers: { osnova: { command: "node", args: ["/p/osnova/bin.js", "mcp"] } } } });
    expect(JSON.parse(append.merged).mcpServers).toEqual({ other: { command: "other" }, osnova: { command: "osnova", args: ["mcp"] } });
  });

  it("repoints a kilo command array and keeps comments and other keys", async () => {
    const file = path.join(home, ".config", "kilo", "kilo.jsonc");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{\n  // mine\n  "mcp": {\n    "osnova": {\n      "type": "local",\n      "command": ["node", "/x/osnova-strict/dist/bin.js", "mcp"],\n      "enabled": true\n    }\n  }\n}\n');
    const update = await previewSetup("kilo", { home });
    expect(update.action).toBe("update");
    expect(update.merged).toContain("// mine");
    expect(update.merged).toContain('"command": ["osnova", "mcp"]');
    expect(JSON.parse(update.merged.replace(/^\s*\/\/.*$/gm, ""))).toEqual({ mcp: { osnova: { type: "local", command: ["osnova", "mcp"], enabled: true } } });
  });

  it("uses the opencode and kilo local server shape", async () => {
    const preview = await previewSetup("kilo", { home });
    expect(preview.path).toBe(path.join(home, ".config", "kilo", "kilo.jsonc"));
    expect(preview.diff).toContain('+  "mcp": {');
    expect(preview.diff).toContain('+      "type": "local",');
    expect(preview.diff).toContain('+      "command": ["osnova", "mcp"],');
    expect(preview.diff).toContain('+      "enabled": true');
  });

  it("appends a TOML table for codex and detects an existing one", async () => {
    const file = path.join(home, ".codex", "config.toml");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'model = "gpt"\n\n[mcp_servers.other]\ncommand = "other"\n');
    const preview = await previewSetup("codex", { home });
    expect(preview.action).toBe("append");
    expect(preview.merged.endsWith('command = "other"\n\n[mcp_servers.osnova]\ncommand = "osnova"\nargs = ["mcp"]\n')).toBe(true);
    await fs.writeFile(file, 'model = "gpt"\n\n[mcp_servers.osnova]\ncommand = "osnova"\nargs = ["mcp"]\n');
    expect((await previewSetup("codex", { home })).action).toBe("unchanged");
    await fs.writeFile(file, '[mcp_servers.osnova]\ncommand = "elsewhere"\n');
    expect((await previewSetup("codex", { home })).action).toBe("conflict");
  });

  it("repoints the codex table and keeps its other keys and tool approval tables", async () => {
    const file = path.join(home, ".codex", "config.toml");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tools = '[mcp_servers.osnova.tools.osnova_footing]\napproval_mode = "approve"\n';
    await fs.writeFile(file, `model = "gpt"\n\n[mcp_servers.osnova]\ncommand = "/opt/node"\nargs = ["/x/osnova-strict/dist/bin.js", "mcp"]\nstartup_timeout_sec = 30\n\n${tools}`);
    const update = await previewSetup("codex", { home });
    expect(update.action).toBe("update");
    expect(update.merged).toBe(`model = "gpt"\n\n[mcp_servers.osnova]\ncommand = "osnova"\nargs = ["mcp"]\nstartup_timeout_sec = 30\n\n${tools}`);
    await fs.writeFile(file, update.merged);
    expect((await previewSetup("codex", { home })).action).toBe("unchanged");
  });

  it("honors a custom command and an explicit config path", async () => {
    const custom = path.join(home, "custom.json");
    const preview = await previewSetup("cursor", { home, configPath: custom, command: ["npx", "-y", "@getdomovoi/osnova"] });
    expect(preview.path).toBe(custom);
    expect(JSON.parse(preview.merged)).toEqual({ mcpServers: { osnova: { command: "npx", args: ["-y", "@getdomovoi/osnova", "mcp"] } } });
  });

  it("rejects unknown clients and a config path outside the home directory", async () => {
    await expect(previewSetup("vim" as never, { home })).rejects.toThrow(/unknown client/);
    await expect(previewSetup("cursor", { home, configPath: "/etc/passwd" })).rejects.toThrow(/inside the home directory/);
  });

  it("prints the diff from the CLI and never writes", async () => {
    const out: string[] = [];
    const code = await runCli(["setup", "--preview", "--client", "cursor", "--home", home], { stdout: (text) => out.push(text), stderr: (text) => out.push(text) });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("osnova setup preview: cursor, create");
    expect(out.join("\n")).toContain("+++ ");
    expect(out.join("\n")).toContain("osnova never applies this change");
    expect(await snapshot()).toEqual([]);
    await expect(runCli(["setup", "--client", "cursor", "--home", home])).rejects.toThrow(/--preview/);
    await expect(runCli(["setup", "--preview", "--home", home])).rejects.toThrow(/--client/);
  });
});
