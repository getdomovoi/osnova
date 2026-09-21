import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../src/cli/cli.js";

function capture(stdin = "") {
  const out: string[] = []; const err: string[] = [];
  return { out, err, io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t), stdin: async () => stdin } };
}

describe("osnova hook", () => {
  it("prints starting points for a prompt, nothing for a slash command, and the tool contract for a session", async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-hook-"));
    try {
      const root = path.join(temporary, "ws"); await fs.mkdir(root);
      await fs.writeFile(path.join(root, "billing.ts"), "export class Invoice { total(): number { return 1; } }\nexport function renderInvoice(i: Invoice) { return i.total(); }\n");
      await fs.writeFile(path.join(root, "other.ts"), "export function unrelated() { return 2; }\n");
      const cacheDir = path.join(temporary, "cache");
      const payload = JSON.stringify({ prompt: "why does renderInvoice return the wrong total", cwd: root });
      let c = capture(payload);
      expect(await runCli(["hook", "prompt", "--cache-dir", cacheDir], c.io)).toBe(0);
      expect(c.out).toEqual([]);
      const { buildIndex } = await import("../src/index.js");
      await buildIndex(root, { cacheDir });
      expect(await runCli(["hook", "prompt", "--cache-dir", cacheDir], c.io)).toBe(0);
      expect(c.out.join("\n")).toContain("[osnova] starting points");
      expect(c.out.join("\n")).toContain("billing.ts#renderInvoice");
      expect(c.out.join("\n").length).toBeLessThanOrEqual(1_024);
      c = capture(JSON.stringify({ prompt: "/clear", cwd: root }));
      expect(await runCli(["hook", "prompt", "--cache-dir", cacheDir], c.io)).toBe(0);
      expect(c.out).toEqual([]);
      c = capture(JSON.stringify({ prompt: "should we include more feedback within the unrelated harness", cwd: root }));
      expect(await runCli(["hook", "prompt", "--cache-dir", cacheDir], c.io)).toBe(0);
      expect(c.out).toEqual([]);
      c = capture(JSON.stringify({ prompt: "what does `unrelated` return", cwd: root }));
      expect(await runCli(["hook", "prompt", "--cache-dir", cacheDir], c.io)).toBe(0);
      expect(c.out.join("\n")).toContain("other.ts#unrelated");
      c = capture(JSON.stringify({ prompt: "short", cwd: root }));
      expect(await runCli(["hook", "prompt", "--cache-dir", cacheDir], c.io)).toBe(0);
      expect(c.out).toEqual([]);
      c = capture(JSON.stringify({ cwd: root }));
      expect(await runCli(["hook", "session", "--cache-dir", cacheDir], c.io)).toBe(0);
      expect(c.out.join("\n")).toContain("osnova_footing");
      expect(c.out.join("\n")).toMatch(/Indexed: 2 files, \d+ symbols\./);
      c = capture(JSON.stringify({ prompt: "why does renderInvoice return the wrong total", cwd: path.join(temporary, "missing") }));
      expect(await runCli(["hook", "prompt", "--cache-dir", cacheDir], c.io)).toBe(0);
      expect(c.out).toEqual([]);
      c = capture(payload);
      expect(await runCli(["hook", "prompt", "--client", "codex", "--cache-dir", cacheDir], c.io)).toBe(0);
      const codex = JSON.parse(c.out.join("\n"));
      expect(codex.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
      expect(codex.hookSpecificOutput.additionalContext).toContain("billing.ts#renderInvoice");
      c = capture(JSON.stringify({ cwd: root }));
      expect(await runCli(["hook", "session", "--client", "codex", "--cache-dir", cacheDir], c.io)).toBe(0);
      expect(JSON.parse(c.out.join("\n")).hookSpecificOutput.hookEventName).toBe("SessionStart");
      c = capture();
      expect(await runCli(["hook", "install-preview", "--command", "node", "--command", "/opt/osnova/dist/bin.js"], c.io)).toBe(0);
      expect(c.out.join("\n").split("\n")[1]).toContain("at most once per diff per session, and only when more than OSNOVA_HOOK_SETTLE_BLOCK_AT");
      const snippet = JSON.parse(c.out.join("\n").split("\n").slice(2).join("\n"));
      expect(snippet.hooks.UserPromptSubmit[0].hooks[0].command).toBe("node /opt/osnova/dist/bin.js hook prompt");
      expect(snippet.hooks.SessionStart[0].hooks[0].command).toBe("node /opt/osnova/dist/bin.js hook session");
      expect(snippet.hooks.Stop[0].hooks[0].command).toBe("node /opt/osnova/dist/bin.js hook stop");
      expect(snippet.hooks.PostToolUse).toBeUndefined();
      c = capture();
      expect(await runCli(["hook", "install-preview", "--nudge", "--command", "node", "--command", "/opt/osnova/dist/bin.js"], c.io)).toBe(0);
      const withNudge = JSON.parse(c.out.join("\n").split("\n").slice(2).join("\n"));
      expect(withNudge.hooks.PostToolUse[0].matcher).toBe("Grep|Bash");
      expect(withNudge.hooks.PostToolUse[0].hooks[0].command).toBe("node /opt/osnova/dist/bin.js hook tool");
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  });

  it("tool nudges once per session when a grep names an indexed symbol with resolved callers, and stays silent otherwise", async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-hook-"));
    try {
      const root = path.join(temporary, "ws"); await fs.mkdir(root);
      await fs.writeFile(path.join(root, "billing.ts"), "export class Invoice { total(): number { return 1; } }\nexport function renderInvoice(i: Invoice) { return i.total(); }\n");
      await fs.writeFile(path.join(root, "report.ts"), "import { renderInvoice, Invoice } from './billing.js';\nexport function report() { return renderInvoice(new Invoice()); }\nexport function unrelated() { return 2; }\n");
      const cacheDir = path.join(temporary, "cache");
      const { buildIndex } = await import("../src/index.js");
      await buildIndex(root, { cacheDir });
      const session = `osnova-test-${Date.now()}`;
      const payload = (toolName: string, toolInput: Record<string, unknown>) => JSON.stringify({ session_id: session, cwd: root, tool_name: toolName, tool_input: toolInput });
      let c = capture(payload("Grep", { pattern: "renderInvoice", path: root }));
      expect(await runCli(["hook", "tool", "--cache-dir", cacheDir], c.io)).toBe(0);
      const first = JSON.parse(c.out.join("\n"));
      expect(first.hookSpecificOutput.hookEventName).toBe("PostToolUse");
      expect(first.hookSpecificOutput.additionalContext).toContain("billing.ts#renderInvoice is indexed: 1 resolved call sites in 1 files");
      c = capture(payload("Bash", { command: "grep -rn \"renderInvoice\" src" }));
      expect(await runCli(["hook", "tool", "--cache-dir", cacheDir], c.io)).toBe(0);
      expect(c.out).toEqual([]);
      c = capture(payload("Bash", { command: "rg -n 'unrelated' ." }));
      expect(await runCli(["hook", "tool", "--cache-dir", cacheDir], c.io)).toBe(0);
      expect(c.out).toEqual([]);
      c = capture(JSON.stringify({ session_id: `${session}-c`, cwd: root, tool_name: "Bash", tool_input: { command: "rg -n -t ts -e renderInvoice src" } }));
      expect(await runCli(["hook", "tool", "--cache-dir", cacheDir], c.io)).toBe(0);
      expect(c.out.join("\n")).toContain("billing.ts#renderInvoice is indexed");
      c = capture(payload("Bash", { command: "rg -n 'unrelated' ." }));
      expect(await runCli(["hook", "tool", "--cache-dir", cacheDir], c.io)).toBe(0);
      expect(c.out).toEqual([]);
      c = capture(JSON.stringify({ session_id: `${session}-d`, cwd: root, tool_name: "Bash", tool_input: { command: "grep -n \"\\.total(\" billing.ts" } }));
      expect(await runCli(["hook", "tool", "--cache-dir", cacheDir], c.io)).toBe(0);
      expect(c.out.join("\n")).toContain("billing.ts#Invoice.total is indexed: 1 resolved call sites");
      c = capture(payload("Grep", { pattern: "render.*Invoice" }));
      expect(await runCli(["hook", "tool", "--cache-dir", cacheDir], c.io)).toBe(0);
      expect(c.out).toEqual([]);
      c = capture(JSON.stringify({ session_id: `${session}-b`, cwd: root, tool_name: "Bash", tool_input: { command: "cat x | rg --type ts \\bInvoice\\b" } }));
      expect(await runCli(["hook", "tool", "--cache-dir", cacheDir], c.io)).toBe(0);
      expect(c.out.join("\n")).toContain("billing.ts#Invoice is indexed");
      await expect(fs.access(path.join(cacheDir, "hook-state", `${session}.json`))).resolves.toBeUndefined();
      await expect(fs.access(path.join(os.tmpdir(), "osnova-hook-nudges", `${session}.json`))).rejects.toThrow();
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  });

  it("session on a cold repository starts a background build and answers from the next cache; the workspace is the git root", async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-hook-cold-"));
    try {
      const root = path.join(temporary, "ws"); await fs.mkdir(path.join(root, "src"), { recursive: true });
      const { execFileSync } = await import("node:child_process");
      const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      git("init", "-q"); git("config", "user.email", "t@example.com"); git("config", "user.name", "t");
      await fs.writeFile(path.join(root, "src", "lib.ts"), "export function total(n: number) { return n; }\n");
      await fs.writeFile(path.join(root, "src", "use.ts"), "import { total } from './lib.js';\nexport function report() { return total(1); }\n");
      git("add", "."); git("commit", "-q", "-m", "init");
      const cacheDir = path.join(temporary, "cache");
      const { runHook } = await import("../src/cli/hook.js");
      const builds: string[] = [];
      let c = capture();
      await runHook("session", JSON.stringify({ cwd: path.join(root, "src") }), c.io, { cacheDir, sessionWaitMs: 0, backgroundBuild: (workspace) => builds.push(workspace) });
      expect(builds.map((dir) => path.resolve(dir))).toEqual([path.resolve(await fs.realpath(root))]);
      expect(c.out.join("\n")).toContain("building in the background");
      c = capture();
      const { buildIndex: build } = await import("../src/index.js");
      await runHook("session", JSON.stringify({ cwd: path.join(root, "src") }), c.io, { cacheDir: path.join(temporary, "cache-2"), sessionWaitMs: 10_000, backgroundBuild: (workspace, dir) => { void build(workspace, { cacheDir: dir }); } });
      expect(c.out.join("\n")).toMatch(/Indexed: 2 files/);
      const { buildIndex } = await import("../src/index.js");
      await buildIndex(root, { cacheDir });
      c = capture();
      await runHook("session", JSON.stringify({ cwd: path.join(root, "src") }), c.io, { cacheDir, backgroundBuild: (workspace) => builds.push(workspace) });
      expect(builds).toHaveLength(1);
      expect(c.out.join("\n")).toMatch(/Indexed: 2 files/);
      c = capture();
      await runHook("prompt", JSON.stringify({ prompt: "why does `report` call total", cwd: path.join(root, "src") }), c.io, { cacheDir });
      expect(c.out.join("\n")).toContain("src/use.ts#report");
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  });

  it("stop continues the turn once per diff when the dependents pass the threshold, warns otherwise, and keeps its state under the cache directory", async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-hook-stop-"));
    try {
      const root = path.join(temporary, "ws"); await fs.mkdir(root);
      const { execFileSync } = await import("node:child_process");
      const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      git("init", "-q"); git("config", "user.email", "t@example.com"); git("config", "user.name", "t");
      const lib = (tax: string, total: string) => `export function tax(n: number) {\n  return ${tax};\n}\nexport function total(n: number) {\n  return ${total};\n}\n`;
      await fs.writeFile(path.join(root, "lib.ts"), lib("n", "n"));
      await fs.writeFile(path.join(root, "use.ts"), "import { total, tax } from './lib.js';\nexport function report() { return total(1) + tax(1); }\n");
      await fs.writeFile(path.join(root, "alt.ts"), "import { total } from './lib.js';\nexport function summary() { return total(2); }\n");
      git("add", "."); git("commit", "-q", "-m", "init");
      const cacheDir = path.join(temporary, "cache");
      const session = `osnova-stop-${Date.now()}`;
      const stateFile = path.join(cacheDir, "hook-state", `${session}.json`);
      const { runHook } = await import("../src/cli/hook.js");
      let c = capture();
      await runHook("stop", JSON.stringify({ cwd: root, session_id: session }), c.io, { cacheDir });
      expect(c.out).toEqual([]);
      const { buildIndex } = await import("../src/index.js");
      await buildIndex(root, { cacheDir });
      c = capture();
      await runHook("stop", JSON.stringify({ cwd: root, session_id: session }), c.io, { cacheDir });
      expect(c.out).toEqual([]);
      await fs.writeFile(path.join(root, "lib.ts"), lib("n * 3", "n"));
      c = capture();
      await runHook("stop", JSON.stringify({ cwd: root, session_id: session }), c.io, { cacheDir });
      const warned = JSON.parse(c.out.join("\n"));
      expect(warned.decision).toBeUndefined();
      expect(warned.hookSpecificOutput).toBeUndefined();
      expect(warned.systemMessage).toContain("- use.ts: report:");
      expect(warned.systemMessage).toMatch(/1 indexed dependents in 1 files/);
      await expect(fs.access(stateFile)).rejects.toThrow();
      await fs.writeFile(path.join(root, "lib.ts"), lib("n", "n * 2"));
      c = capture();
      await runHook("stop", JSON.stringify({ cwd: root, session_id: session }), c.io, { cacheDir });
      const fired = JSON.parse(c.out.join("\n"));
      expect(fired.decision).toBeUndefined();
      expect(fired.hookSpecificOutput.hookEventName).toBe("Stop");
      expect(fired.hookSpecificOutput.additionalContext).toContain("- use.ts: report:");
      expect(fired.hookSpecificOutput.additionalContext).toContain("- alt.ts: summary:");
      expect(fired.hookSpecificOutput.additionalContext).toMatch(/2 indexed dependents in 2 files/);
      expect(fired.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(1_536);
      await expect(fs.access(stateFile)).resolves.toBeUndefined();
      c = capture();
      await runHook("stop", JSON.stringify({ cwd: root, session_id: session }), c.io, { cacheDir });
      const repeated = JSON.parse(c.out.join("\n"));
      expect(repeated.hookSpecificOutput).toBeUndefined();
      expect(repeated.decision).toBeUndefined();
      expect(repeated.systemMessage).toMatch(/2 indexed dependents in 2 files/);
      await fs.writeFile(path.join(root, "lib.ts"), lib("n", "n * 4"));
      c = capture();
      await runHook("stop", JSON.stringify({ cwd: root, session_id: session }), c.io, { cacheDir });
      expect(JSON.parse(c.out.join("\n")).hookSpecificOutput.hookEventName).toBe("Stop");
      c = capture();
      await runHook("stop", JSON.stringify({ cwd: root, session_id: session, stop_hook_active: true }), c.io, { cacheDir });
      expect(c.out).toEqual([]);
      c = capture();
      await runHook("stop", JSON.stringify({ cwd: root, session_id: `${session}-codex` }), c.io, { cacheDir, client: "codex" });
      const codex = JSON.parse(c.out.join("\n"));
      expect(codex.decision).toBe("block");
      expect(codex.reason).toContain("- alt.ts: summary:");
      expect(codex.hookSpecificOutput).toBeUndefined();
      c = capture();
      await runHook("stop", JSON.stringify({ cwd: root, session_id: `${session}-codex` }), c.io, { cacheDir, client: "codex" });
      const codexAgain = JSON.parse(c.out.join("\n"));
      expect(codexAgain.decision).toBeUndefined();
      expect(codexAgain.systemMessage).toContain("- alt.ts: summary:");
      c = capture();
      await runHook("stop", JSON.stringify({ cwd: root, conversation_id: `${session}-cursor` }), c.io, { cacheDir, client: "cursor" });
      expect(JSON.parse(c.out.join("\n")).followup_message).toContain("- use.ts: report:");
      c = capture();
      await runHook("stop", JSON.stringify({ cwd: root, conversation_id: `${session}-cursor` }), c.io, { cacheDir, client: "cursor" });
      expect(c.out).toEqual([]);
      await expect(fs.access(path.join(cacheDir, "hook-state", `${session}-cursor.json`))).resolves.toBeUndefined();
      process.env.OSNOVA_HOOK_SETTLE_BLOCK_AT = "5";
      try {
        c = capture();
        await runHook("stop", JSON.stringify({ cwd: root, session_id: `${session}-high` }), c.io, { cacheDir });
        const under = JSON.parse(c.out.join("\n"));
        expect(under.hookSpecificOutput).toBeUndefined();
        expect(under.systemMessage).toMatch(/2 indexed dependents/);
      } finally { delete process.env.OSNOVA_HOOK_SETTLE_BLOCK_AT; }
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  });
});

describe("stop reason layout", () => {
  it("groups dependents by file, caps symbols per file, and counts the files that do not fit the budget", async () => {
    const { formatStopReason } = await import("../src/cli/hook.js");
    const symbol = (file: string, name: string, line: number) => ({ qualifiedName: `${file}#${name}`, name, kind: "function", file, span: { startLine: line, endLine: line, startColumn: 0, endColumn: 0 }, language: "typescript" }) as never;
    const dependents = [];
    for (let f = 0; f < 40; f += 1) for (let n = 0; n < 8; n += 1) dependents.push({ snapshot: "current" as const, symbol: symbol(`src/file${f}.ts`, `fn${n}`, n + 1), file: `src/file${f}.ts` });
    dependents.push({ snapshot: "current" as const, symbol: null, file: "src/plain.ts" });
    const result = { changes: [{ after: { symbol: symbol("src/core.ts", "core", 1) } }], dependents, uncertainty: { unresolvedEdges: 3 } } as never;
    const text = formatStopReason(result, 1_536);
    expect(text.length).toBeLessThanOrEqual(1_536);
    expect(text).toContain("321 indexed dependents in 41 files");
    expect(text).toMatch(/- src\/file0\.ts: fn0:1, fn1:2, fn2:3, fn3:4, fn4:5, fn5:6 and 2 more/);
    expect(text).toMatch(/- \d+ more files with \d+ dependents omitted; osnova_settle lists them all\./);
    expect(text).toContain("3 unresolved edges are not listed");
    expect(text.split("\n").every((line) => !line.includes("output truncated"))).toBe(true);
  });
});
