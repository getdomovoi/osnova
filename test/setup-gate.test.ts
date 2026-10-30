import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../src/cli/cli.js";

let home: string;
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-setup-gate-")); });
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });
function capture() { const out: string[] = []; return { out, io: { stdout: (t: string) => out.push(t), stderr: (t: string) => out.push(`ERR ${t}`) } }; }
async function setup(...args: string[]): Promise<string> {
  const c = capture();
  expect(await runCli(["setup", ...args, "--home", home, ...(args.includes("--uninstall") ? [] : ["--command", "osnova"])], c.io)).toBe(0);
  return c.out.join("\n");
}
const json = async (...parts: string[]) => JSON.parse(await fs.readFile(path.join(home, ...parts), "utf8"));

describe("osnova setup --gate", () => {
  it("adds the gate to Claude Code, Codex and Cursor hooks only on request, and a second run changes nothing", async () => {
    await setup("--apply", "--hooks");
    expect((await json(".claude", "settings.json")).hooks.PreToolUse).toBeUndefined();
    await setup("--apply", "--hooks", "--gate");
    expect((await json(".claude", "settings.json")).hooks.PreToolUse).toEqual([{ matcher: "Grep|Glob|Bash|mcp__.*osnova.*", hooks: [{ type: "command", command: "osnova hook gate", timeout: 10 }] }]);
    expect(await setup("--apply", "--hooks", "--gate")).toContain("hooks, unchanged");
    expect(await setup("--apply", "--hooks")).toContain("hooks, unchanged");

    await setup("--apply", "--hooks", "--gate", "--client", "codex");
    expect((await json(".codex", "hooks.json")).hooks.PreToolUse[0]).toEqual({ matcher: "shell|grep|glob|search|Bash|Grep|Glob|mcp__.*osnova.*", hooks: [{ type: "command", command: "osnova hook gate --client codex --adaptive", timeout: 10 }] });

    await setup("--apply", "--hooks", "--gate", "--client", "cursor");
    const cursor = (await json(".cursor", "hooks.json")).hooks;
    for (const event of ["beforeShellExecution", "preToolUse", "afterMCPExecution"]) expect(cursor[event]).toEqual([{ command: "osnova hook gate --client cursor", timeout: 10 }]);
    expect(cursor.stop).toEqual([{ command: "osnova hook stop --client cursor", timeout: 30 }]);
    expect(await setup("--apply", "--hooks", "--gate", "--client", "cursor")).toContain("hooks, unchanged");
  });

  it("installs the gate plugin beside the OpenCode plugin and the Pi extension, and uninstall removes it", async () => {
    await fs.mkdir(path.join(home, ".config", "opencode"), { recursive: true });
    await fs.mkdir(path.join(home, ".pi", "agent"), { recursive: true });
    await setup("agents", "--apply", "--gate");
    const opencodeGate = path.join(home, ".config", "opencode", "plugins", "osnova-gate.js");
    const piGate = path.join(home, ".pi", "agent", "extensions", "osnova-gate.ts");
    expect(await fs.readFile(opencodeGate, "utf8")).toContain("tool.execute.before");
    expect(await fs.readFile(piGate, "utf8")).toContain("tool_call");
    expect(existsSync(path.join(home, ".config", "opencode", "plugins", "osnova.js"))).toBe(true);
    await setup("agents", "--uninstall", "--apply");
    expect(existsSync(opencodeGate)).toBe(false);
    expect(existsSync(piGate)).toBe(false);
  });

  it("refuses --gate without hooks or a plugin, and on uninstall", async () => {
    await expect(runCli(["setup", "--apply", "--gate", "--home", home], capture().io)).rejects.toThrow(/--gate goes with --hooks or --plugin/);
    await expect(runCli(["setup", "agents", "--uninstall", "--gate", "--home", home], capture().io)).rejects.toThrow(/takes no --command, --nudge or --gate/);
  });
});

