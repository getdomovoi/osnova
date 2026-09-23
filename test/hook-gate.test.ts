import { beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../src/cli/cli.js";
import { shellStages } from "../src/cli/gate.js";

// The gate is a PreToolUse hook: it denies plain search inside an indexed workspace until osnova has
// run in the current turn. Every case below mirrors one the hand-written reference gate answered.

function capture(stdin = "") {
  const out: string[] = []; const err: string[] = [];
  return { out, err, io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t), stdin: async () => stdin } };
}

let root = "";
let cacheDir = "";
let outside = "";

async function gate(payload: Record<string, unknown>, extra: readonly string[] = []) {
  const c = capture(JSON.stringify({ cwd: root, session_id: "gate-session", ...payload }));
  const code = await runCli(["hook", "gate", "--cache-dir", cacheDir, ...extra], c.io);
  const text = c.out.join("");
  return { code, text, decision: text.length === 0 ? undefined : (JSON.parse(text) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput };
}

async function newTurn(sessionId = "gate-session") {
  const c = capture(JSON.stringify({ prompt: "a fresh prompt that starts a new turn", cwd: root, session_id: sessionId }));
  await runCli(["hook", "prompt", "--cache-dir", cacheDir], c.io);
}

async function markOsnovaTool(sessionId = "gate-session") {
  const c = capture(JSON.stringify({ cwd: root, session_id: sessionId, tool_name: "mcp__osnova__osnova_ground", tool_input: { question: "x" } }));
  await runCli(["hook", "tool", "--cache-dir", cacheDir], c.io);
}

const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
const grep = (pattern: string, target?: string) => ({ tool_name: "Grep", tool_input: { pattern, ...(target === undefined ? {} : { path: target }) } });

describe("osnova hook gate", () => {
  beforeAll(async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-gate-"));
    root = path.join(temporary, "ws");
    outside = path.join(temporary, "elsewhere");
    cacheDir = path.join(temporary, "cache");
    await fs.mkdir(path.join(root, "sub"), { recursive: true });
    await fs.mkdir(path.join(root, ".hidden"), { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(root, "billing.ts"), "export function total(): number { return 1; }\n");
    await fs.writeFile(path.join(root, "sub", "helper.ts"), "export function helper(): number { return 2; }\n");
    await fs.writeFile(path.join(root, ".hidden", "notes.txt"), "not indexed\n");
    await fs.writeFile(path.join(outside, "notes.txt"), "elsewhere\n");
    await fs.writeFile(path.join(outside, "my notes.txt"), "elsewhere\n");
    const { buildIndex } = await import("../src/index.js");
    await buildIndex(root, { cacheDir });
    await newTurn();
  });

  it("denies the Grep tool inside the indexed workspace", async () => {
    const { code, decision } = await gate(grep("total"));
    expect(code).toBe(0);
    expect(decision?.permissionDecision).toBe("deny");
    expect(decision?.permissionDecisionReason).toContain("osnova_ground");
  });

  it("names the indexed file count in the deny reason", async () => {
    const { decision } = await gate(grep("total"));
    expect(decision?.permissionDecisionReason).toMatch(/2 indexed files/);
  });

  it("denies the Glob tool inside the indexed workspace", async () => {
    const { decision } = await gate({ tool_name: "Glob", tool_input: { pattern: "**/*.ts" } });
    expect(decision?.permissionDecision).toBe("deny");
  });

  it("denies rg, git grep, find, and a chained grep in a subdirectory", async () => {
    for (const command of ["rg foo", "git grep foo", "find . -name x", "cd sub && grep -rn foo ."]) {
      const { decision } = await gate(bash(command));
      expect(decision?.permissionDecision, command).toBe("deny");
    }
  });

  it("allows a grep that only filters a pipeline", async () => {
    const { decision } = await gate(bash("git status | grep foo"));
    expect(decision).toBeUndefined();
  });

  it("allows a search that targets a path outside the workspace", async () => {
    expect((await gate(bash(`grep -n x ${outside}/notes.txt`))).decision).toBeUndefined();
    expect((await gate(grep("x", outside))).decision).toBeUndefined();
  });

  it("does not mistake a pipe inside a quoted pattern for a pipeline", async () => {
    expect((await gate(bash(`grep -nE "FAIL|error" ${outside}/notes.txt`))).decision).toBeUndefined();
    expect((await gate(bash(`grep -nE 'FAIL|error' ${outside}/notes.txt`))).decision).toBeUndefined();
    expect((await gate(bash('rg "FAIL|error"'))).decision?.permissionDecision).toBe("deny");
  });

  it("keeps a Windows path whole instead of reading its separators as escapes", () => {
    const [stage] = shellStages(String.raw`grep -n x C:\Users\me\Temp\notes.txt`);
    expect(stage?.words).toEqual(["grep", "-n", "x", String.raw`C:\Users\me\Temp\notes.txt`]);
  });

  it("still reads a backslash that escapes a space or a quote", async () => {
    const [stage] = shellStages(String.raw`grep -n x /tmp/my\ notes.txt`);
    expect(stage?.words).toEqual(["grep", "-n", "x", "/tmp/my notes.txt"]);
    expect((await gate(bash(String.raw`grep -n x ${outside}/my\ notes.txt`))).decision, "escaped space, real file").toBeUndefined();
  });

  it("allows a command that is not a search", async () => {
    expect((await gate(bash("ls -la"))).decision).toBeUndefined();
  });

  it("allows a tool it does not gate", async () => {
    expect((await gate({ tool_name: "Read", tool_input: { file_path: path.join(root, "billing.ts") } })).decision).toBeUndefined();
  });

  it("allows a search whose target holds no indexed file", async () => {
    expect((await gate(bash("rg foo ./.hidden"))).decision).toBeUndefined();
    expect((await gate(grep("foo", path.join(root, ".hidden")))).decision).toBeUndefined();
  });

  it("allows search after an osnova MCP tool ran in the same turn, and denies again on the next turn", async () => {
    expect((await gate(grep("total"))).decision?.permissionDecision).toBe("deny");
    await markOsnovaTool();
    expect((await gate(grep("total"))).decision).toBeUndefined();
    await newTurn();
    expect((await gate(grep("total"))).decision?.permissionDecision).toBe("deny");
  });

  it("allows a search chained after the osnova CLI in one command", async () => {
    await newTurn();
    expect((await gate(bash("osnova ground foo; rg foo"))).decision).toBeUndefined();
  });

  it("does nothing when the workspace is the home directory", async () => {
    await newTurn();
    expect((await gate(grep("total"), ["--workspace", os.homedir()])).decision).toBeUndefined();
  });

  it("does nothing when the gate is turned off", async () => {
    await newTurn();
    const previous = process.env.OSNOVA_GATE;
    process.env.OSNOVA_GATE = "off";
    try {
      expect((await gate(grep("total"))).decision).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.OSNOVA_GATE; else process.env.OSNOVA_GATE = previous;
    }
  });

  it("speaks each client's deny shape", async () => {
    await newTurn();
    const raw = async (client: string) => {
      const c = capture(JSON.stringify({ cwd: root, session_id: "gate-session", tool_name: "Grep", tool_input: { pattern: "total" } }));
      await runCli(["hook", "gate", "--cache-dir", cacheDir, "--client", client], c.io);
      return JSON.parse(c.out.join("")) as Record<string, never>;
    };
    expect(await raw("codex")).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
    expect(await raw("cursor")).toMatchObject({ permission: "deny" });
    expect((await raw("cursor")).agent_message).toContain("osnova_ground");
    expect(await raw("pi")).toMatchObject({ block: true });
    expect((await raw("pi")).reason).toContain("osnova_ground");
  });

  it("reads a call by its shape, so a lowercase codex tool and an argv list are gated too", async () => {
    await newTurn();
    expect((await gate({ tool_name: "grep", tool_input: { pattern: "total" } })).decision?.permissionDecision).toBe("deny");
    expect((await gate({ tool_name: "search", tool_input: { queries: ["total"], path: root } })).decision?.permissionDecision).toBe("deny");
    expect((await gate({ tool_name: "shell", tool_input: { command: ["rg", "foo"] } })).decision?.permissionDecision).toBe("deny");
    expect((await gate({ tool_name: "shell", tool_input: { command: ["ls", "-la"] } })).decision).toBeUndefined();
    expect((await gate({ tool_name: "grep", tool_input: { pattern: "total", path: outside } })).decision).toBeUndefined();
  });

  it("lifts the denial when the osnova server is named in its own field", async () => {
    await newTurn();
    expect((await gate(grep("total"))).decision?.permissionDecision).toBe("deny");
    const c = capture(JSON.stringify({ cwd: root, session_id: "gate-session", tool_name: "osnova_ground", mcp_server_name: "osnova" }));
    await runCli(["hook", "mark", "--cache-dir", cacheDir, "--client", "cursor"], c.io);
    expect((await gate(grep("total"))).decision).toBeUndefined();
  });

  it("allows everything when the workspace has no cache at all", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-gate-cold-"));
    const c = capture(JSON.stringify({ cwd: empty, session_id: "cold", tool_name: "Grep", tool_input: { pattern: "x" } }));
    expect(await runCli(["hook", "gate", "--cache-dir", path.join(empty, "cache")], c.io)).toBe(0);
    expect(c.out).toEqual([]);
  });
});
