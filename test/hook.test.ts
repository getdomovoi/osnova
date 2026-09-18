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
      expect(codex.additionalContext).toContain("billing.ts#renderInvoice");
      c = capture();
      expect(await runCli(["hook", "install-preview", "--command", "node", "--command", "/opt/osnova/dist/bin.js"], c.io)).toBe(0);
      const snippet = JSON.parse(c.out.join("\n").split("\n").slice(1).join("\n"));
      expect(snippet.hooks.UserPromptSubmit[0].hooks[0].command).toBe("node /opt/osnova/dist/bin.js hook prompt");
      expect(snippet.hooks.SessionStart[0].hooks[0].command).toBe("node /opt/osnova/dist/bin.js hook session");
      expect(snippet.hooks.Stop[0].hooks[0].command).toBe("node /opt/osnova/dist/bin.js hook stop");
      expect(snippet.hooks.PostToolUse[0].matcher).toBe("Grep|Bash");
      expect(snippet.hooks.PostToolUse[0].hooks[0].command).toBe("node /opt/osnova/dist/bin.js hook tool");
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
      await runHook("session", JSON.stringify({ cwd: path.join(root, "src") }), c.io, { cacheDir, backgroundBuild: (workspace) => builds.push(workspace) });
      expect(builds.map((dir) => path.resolve(dir))).toEqual([path.resolve(await fs.realpath(root))]);
      expect(c.out.join("\n")).toContain("building in the background");
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

  it("stop blocks once with the dependents of the uncommitted diff, and stays silent otherwise", async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-hook-stop-"));
    try {
      const root = path.join(temporary, "ws"); await fs.mkdir(root);
      const { execFileSync } = await import("node:child_process");
      const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      git("init", "-q"); git("config", "user.email", "t@example.com"); git("config", "user.name", "t");
      await fs.writeFile(path.join(root, "lib.ts"), "export function total(n: number) {\n  return n;\n}\n");
      await fs.writeFile(path.join(root, "use.ts"), "import { total } from './lib.js';\nexport function report() { return total(1); }\n");
      git("add", "."); git("commit", "-q", "-m", "init");
      const cacheDir = path.join(temporary, "cache");
      const { runHook } = await import("../src/cli/hook.js");
      let c = capture();
      await runHook("stop", JSON.stringify({ cwd: root }), c.io, { cacheDir });
      expect(c.out).toEqual([]);
      const { buildIndex } = await import("../src/index.js");
      await buildIndex(root, { cacheDir });
      c = capture();
      await runHook("stop", JSON.stringify({ cwd: root }), c.io, { cacheDir });
      expect(c.out).toEqual([]);
      await fs.writeFile(path.join(root, "lib.ts"), "export function total(n: number) {\n  return n * 2;\n}\n");
      c = capture();
      await runHook("stop", JSON.stringify({ cwd: root }), c.io, { cacheDir });
      const decision = JSON.parse(c.out.join("\n"));
      expect(decision.decision).toBe("block");
      expect(decision.reason).toContain("use.ts#report");
      expect(decision.reason.length).toBeLessThanOrEqual(1_536);
      c = capture();
      await runHook("stop", JSON.stringify({ cwd: root, stop_hook_active: true }), c.io, { cacheDir });
      expect(c.out).toEqual([]);
      c = capture();
      await runHook("stop", JSON.stringify({ cwd: root }), c.io, { cacheDir, client: "cursor" });
      expect(JSON.parse(c.out.join("\n")).followup_message).toContain("use.ts#report");
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  });
});
