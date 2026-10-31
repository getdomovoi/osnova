import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../src/cli/cli.js";
import { hookSettingsObject } from "../src/cli/hook.js";

function capture(stdin = "") {
  const out: string[] = []; const err: string[] = [];
  return { out, err, io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t), stdin: async () => stdin } };
}

let temporary: string, root: string, cacheDir: string;
beforeAll(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-gate-"));
  root = path.join(temporary, "ws");
  await fs.mkdir(path.join(root, "src"), { recursive: true }); await fs.mkdir(path.join(root, "config"));
  await fs.writeFile(path.join(root, "src", "app.ts"), "export function total(n: number) { return n; }\n");
  await fs.writeFile(path.join(root, "config", "settings.json"), "{ \"total\": 1 }\n");
  await fs.writeFile(path.join(root, "README.md"), "# total\n");
  cacheDir = path.join(temporary, "cache");
  const { buildIndex } = await import("../src/index.js");
  await buildIndex(root, { cacheDir });
});
afterAll(async () => { await fs.rm(temporary, { recursive: true, force: true }); });

let sessions = 0;
async function run(event: "gate" | "prompt", payload: Record<string, unknown>, ...flags: string[]): Promise<string> {
  const c = capture(JSON.stringify({ cwd: root, ...payload }));
  expect(await runCli(["hook", event, "--cache-dir", cacheDir, ...flags], c.io)).toBe(0);
  return c.out.join("\n");
}
const gate = (session: string, tool_name: string, tool_input: Record<string, unknown>, ...flags: string[]) => run("gate", { session_id: session, tool_name, tool_input }, ...flags);
const fresh = () => `s${(sessions += 1)}`;
const denied = (out: string) => {
  if (out.length === 0) return false;
  const parsed = JSON.parse(out) as { hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string; permissionDecisionReason?: string } };
  expect(parsed.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
  expect(parsed.hookSpecificOutput?.permissionDecisionReason).toContain("osnova_footing");
  return parsed.hookSpecificOutput?.permissionDecision === "deny";
};

describe("osnova hook gate", () => {
  it("denies every search of indexed code in a turn until osnova runs", async () => {
    const session = fresh();
    expect(denied(await gate(session, "Grep", { pattern: "total" }))).toBe(true);
    expect(denied(await gate(session, "Grep", { pattern: "total" }))).toBe(true);
    expect(await gate(session, "mcp__osnova__osnova_ground", { question: "total" })).toBe("");
    expect(await gate(session, "Grep", { pattern: "total" })).toBe("");
    await run("prompt", { session_id: session, prompt: "next turn, fix total" });
    expect(denied(await gate(session, "Grep", { pattern: "total" }))).toBe(true);
  });

  it("starts a turn from a plugin's prompt signal, even before any state exists", async () => {
    const session = fresh();
    expect(await gate(session, "osnova_osnova_footing", { question: "total" })).toBe("");
    expect(await gate(session, "grep", { pattern: "total" })).toBe("");
    expect(await run("gate", { session_id: session, hook_event_name: "UserPromptSubmit" })).toBe("");
    expect(denied(await gate(session, "grep", { pattern: "total" }))).toBe(true);
  });

  it("adaptive mode denies once per turn until it has seen an osnova call, then is strict", async () => {
    const session = fresh();
    const adaptive = (input: Record<string, unknown>) => gate(session, "Bash", input, "--client", "codex", "--adaptive");
    expect(denied(await adaptive({ command: "rg total" }))).toBe(true);
    expect(await adaptive({ command: "rg total" })).toBe("");
    await run("prompt", { session_id: session, prompt: "second turn about total" });
    expect(denied(await adaptive({ command: "rg total" }))).toBe(true);
    expect(await adaptive({ command: "osnova footing total" })).toBe("");
    await run("prompt", { session_id: session, prompt: "third turn about total" });
    expect(denied(await adaptive({ command: "rg total" }))).toBe(true);
    expect(denied(await adaptive({ command: "rg total" }))).toBe(true);
  });

  it("lets search through after an osnova tool or the osnova CLI ran this turn", async () => {
    const mcp = fresh();
    expect(await gate(mcp, "mcp__osnova__osnova_footing", { question: "total" })).toBe("");
    expect(await gate(mcp, "Bash", { command: "rg total src" })).toBe("");
    const cli = fresh();
    expect(await gate(cli, "Bash", { command: "osnova ground total" })).toBe("");
    expect(await gate(cli, "Grep", { pattern: "total" })).toBe("");
    await run("prompt", { session_id: cli, prompt: "another turn about total" });
    expect(denied(await gate(cli, "Grep", { pattern: "total" }))).toBe(true);
  });

  it("gates only searches that reach indexed code", async () => {
    const allowed: [string, Record<string, unknown>][] = [
      ["Grep", { pattern: "total", path: "config" }],
      ["Grep", { pattern: "total", path: path.join(root, "README.md") }],
      ["Grep", { pattern: "total", glob: "*.json" }],
      ["Glob", { pattern: "**/*.md" }],
      ["Grep", { pattern: "total", path: temporary }],
      ["Bash", { command: "grep -rn total config/settings.json README.md" }],
      ["Bash", { command: "git log --oneline | grep total" }],
      ["Bash", { command: "ls src && cat README.md" }],
      ["grep", { pattern: "total", include: "*.json" }],
      ["Read", { file_path: path.join(root, "src", "app.ts") }],
    ];
    for (const [tool, input] of allowed) expect(await gate(fresh(), tool, input), `${tool} ${JSON.stringify(input)}`).toBe("");
    const gated: [string, Record<string, unknown>][] = [
      ["Grep", { pattern: "total", path: "src" }],
      ["Glob", { pattern: "**/*.ts" }],
      ["Bash", { command: "rg -n total" }],
      ["Bash", { command: "cd src && grep -rn total ." }],
      ["Bash", { command: "find . -name '*.ts'" }],
      ["bash", { command: "git grep total" }],
      ["grep", { pattern: "total", path: "src" }],
    ];
    for (const [tool, input] of gated) expect(denied(await gate(fresh(), tool, input)), `${tool} ${JSON.stringify(input)}`).toBe(true);
  });

  it("fails open without a session, without an index, or when switched off", async () => {
    expect(await run("gate", { tool_name: "Grep", tool_input: { pattern: "total" } })).toBe("");
    const c = capture(JSON.stringify({ cwd: path.join(temporary, "elsewhere"), session_id: fresh(), tool_name: "Grep", tool_input: { pattern: "total" } }));
    await fs.mkdir(path.join(temporary, "elsewhere"), { recursive: true });
    expect(await runCli(["hook", "gate", "--cache-dir", cacheDir], c.io)).toBe(0);
    expect(c.out).toEqual([]);
    process.env.OSNOVA_GATE = "off";
    try { expect(await gate(fresh(), "Grep", { pattern: "total" })).toBe(""); } finally { delete process.env.OSNOVA_GATE; }
  });

  it("reads shell commands outside quotes, keeps escaped paths whole, and lets pipeline filters and outside paths through", async () => {
    const outside = path.join(temporary, "outside"); await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "my notes.txt"), "total\n");
    expect(await gate(fresh(), "Bash", { command: `grep -nE "FAIL|error" ${outside}/notes.txt` })).toBe("");
    expect(await gate(fresh(), "Bash", { command: String.raw`grep -n x ${outside}/my\ notes.txt` })).toBe("");
    expect(await gate(fresh(), "Bash", { command: "cd config && grep -rn total ." })).toBe("");
    expect(await gate(fresh(), "Bash", { command: ["rg", "total", "config"] })).toBe("");
    expect(denied(await gate(fresh(), "Bash", { command: 'rg "FAIL|total"' }))).toBe(true);
    expect(denied(await gate(fresh(), "shell", { command: ["rg", "total"] }))).toBe(true);
  });

  it("reads the pattern as a pattern, not a path", async () => {
    for (const command of ['rg "/api/users"', 'grep -rn ".then("', "rg README.md", "grep -rn 'total$'", "rg -t ts total src"]) expect(denied(await gate(fresh(), "Bash", { command })), command).toBe(true);
    for (const command of ["grep -rn total README.md", "rg -t ts total config", "rg 'total$' config"]) expect(await gate(fresh(), "Bash", { command }), command).toBe("");
  });

  it("reads a command a shell runs with -c, a call's own workdir, and |& as a pipe", async () => {
    const outside = path.join(temporary, "outside"); await fs.mkdir(outside, { recursive: true });
    expect(denied(await gate(fresh(), "shell", { command: ["bash", "-lc", "rg -n total src"] }))).toBe(true);
    expect(denied(await gate(fresh(), "Bash", { command: "sh -c 'cd src && rg total'" }))).toBe(true);
    expect(await gate(fresh(), "Bash", { command: "bash -lc 'rg -n total config'" })).toBe("");
    expect(await gate(fresh(), "exec_command", { cmd: "rg total", workdir: outside })).toBe("");
    expect(await gate(fresh(), "Bash", { command: "pnpm test |& grep FAIL" })).toBe("");
  });

  it("reads each tool's own options, list-only modes, unknown assigned variables and shell keywords", async () => {
    const outside = path.join(temporary, "outside"); await fs.mkdir(outside, { recursive: true });
    for (const command of ["grep -E 'a|b' README.md", `grep -rn -E 'total' ${outside}`, `rg --files ${outside}`, `ag -g foo ${outside}`, `ack -f ${outside}`, "D=$HOME/x; rg total $D", `(cd ${outside} && rg 'x)'; rg total)`, `time (cd ${outside} && rg total)`]) {
      expect(await gate(fresh(), "Bash", { command }), command).toBe("");
    }
    for (const command of ["if true; then rg total src; fi", "! rg total src", "for f in x; do grep -rn total src; done", "rg -E utf-8 total src"]) {
      expect(denied(await gate(fresh(), "Bash", { command })), command).toBe(true);
    }
  });

  it("counts only the osnova CLI's own script, not any script in a folder named osnova", async () => {
    const session = fresh();
    expect(await gate(session, "Bash", { command: "node /home/u/projects/osnova/scripts/perf.mjs" })).toBe("");
    expect(denied(await gate(session, "Grep", { pattern: "total" }))).toBe(true);
    const installed = fresh();
    expect(await gate(installed, "Bash", { command: "node ./node_modules/@getdomovoi/osnova/dist/bin.js ground total" })).toBe("");
    expect(await gate(installed, "Grep", { pattern: "total" })).toBe("");
  });

  it("keeps sessions whose ids differ only by a suffix apart", async () => {
    // Session abc.osnova's own state must never read as session abc's record of an osnova call.
    expect(await run("gate", { session_id: "abc.osnova", hook_event_name: "UserPromptSubmit" })).toBe("");
    expect(await run("gate", { session_id: "abc", hook_event_name: "UserPromptSubmit" })).toBe("");
    expect(denied(await gate("abc", "Grep", { pattern: "total" }))).toBe(true);
  });

  it("restores the folder when a subshell closes", async () => {
    expect(denied(await gate(fresh(), "Bash", { command: `(cd ${temporary} && make); rg -n total` }))).toBe(true);
  });

  it("counts osnova run through npx, pnpm exec or node as using osnova, but not a grep for the word", async () => {
    for (const command of ["npx -y @getdomovoi/osnova footing total", "pnpm exec osnova ground total", "node /opt/osnova/dist/bin.js ground total", "bunx @getdomovoi/osnova@0.12.0 thread total"]) {
      const session = fresh();
      expect(await gate(session, "Bash", { command }), command).toBe("");
      expect(await gate(session, "Grep", { pattern: "total" }), command).toBe("");
    }
    expect(denied(await gate(fresh(), "Bash", { command: "grep -rn osnova src" }))).toBe(true);
  });

  it("keeps an osnova call that lands while a parallel search is being decided", async () => {
    const session = fresh();
    await Promise.all([gate(session, "Grep", { pattern: "total" }), gate(session, "mcp__osnova__osnova_ground", { question: "total" })]);
    expect(await gate(session, "Grep", { pattern: "total" })).toBe("");
  });

  it("expands variables the command sets and follows cd inside a subshell", async () => {
    const outside = path.join(temporary, "outside"); await fs.mkdir(outside, { recursive: true });
    expect(await gate(fresh(), "Bash", { command: `S=${outside}; grep -n total $S/notes.txt` })).toBe("");
    expect(await gate(fresh(), "Bash", { command: `S=${outside}; cd "\${S}" && rg total` })).toBe("");
    expect(await gate(fresh(), "Bash", { command: `F=${outside}; (cd $F && find . -name '*.ts' | sort)` })).toBe("");
    expect(await gate(fresh(), "Bash", { command: "rg total $UNSET_DIR/x" })).toBe("");
    expect(denied(await gate(fresh(), "Bash", { command: "(cd src && rg total)" }))).toBe(true);
    expect(denied(await gate(fresh(), "Bash", { command: "D=src; rg total $D" }))).toBe(true);
  });

  it("gates Cursor's shell and tool hooks, sees its MCP calls, and starts a turn on a new generation", async () => {
    const session = fresh();
    const cursor = async (payload: Record<string, unknown>) => {
      const c = capture(JSON.stringify({ cwd: root, conversation_id: session, ...payload }));
      expect(await runCli(["hook", "gate", "--client", "cursor", "--cache-dir", cacheDir], c.io)).toBe(0);
      return c.out.length === 0 ? undefined : JSON.parse(c.out.join("")) as { permission?: string; agent_message?: string };
    };
    const first = await cursor({ generation_id: "g1", command: "rg total" });
    expect(first?.permission).toBe("deny");
    expect(first?.agent_message).toContain("osnova_footing");
    expect((await cursor({ generation_id: "g1", tool_name: "Grep", tool_input: { pattern: "total" } }))?.permission).toBe("deny");
    expect(await cursor({ generation_id: "g1", tool_name: "ground", mcp_server_name: "osnova", tool_input: { question: "total" } })).toBeUndefined();
    expect(await cursor({ generation_id: "g1", command: "rg total" })).toBeUndefined();
    expect((await cursor({ generation_id: "g2", command: "rg total" }))?.permission).toBe("deny");
    const hooks = hookSettingsObject(["osnova"], "cursor", false, true).hooks as Record<string, unknown>;
    for (const event of ["beforeShellExecution", "preToolUse", "afterMCPExecution"]) expect(hooks[event]).toEqual([{ command: "osnova hook gate --client cursor", timeout: 10 }]);
  });

  it("answers Codex in the same deny shape", async () => {
    expect(denied(await gate(fresh(), "Bash", { command: "rg total" }, "--client", "codex"))).toBe(true);
  });

  it("is installed only on request, for Claude Code and Codex", () => {
    const pre = (client: "claude-code" | "codex", gated: boolean) => (hookSettingsObject(["osnova"], client, false, gated).hooks as Record<string, unknown>).PreToolUse;
    expect(pre("claude-code", false)).toBeUndefined();
    expect(pre("claude-code", true)).toEqual([{ matcher: "Grep|Glob|Bash|mcp__.*osnova.*", hooks: [{ type: "command", command: "osnova hook gate", timeout: 10 }] }]);
    expect(pre("codex", true)).toEqual([{ matcher: "shell|grep|glob|search|Bash|Grep|Glob|mcp__.*osnova.*", hooks: [{ type: "command", command: "osnova hook gate --client codex --adaptive", timeout: 10 }] }]);
    expect((hookSettingsObject(["osnova"], "cursor", false, false).hooks as Record<string, unknown>).preToolUse).toBeUndefined();
  });
});
