import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../src/cli/cli.js";
import { hookSearchCodeUnits } from "../src/cli/hook.js";

let temporary: string;
let root: string;
let cacheDir: string;

beforeAll(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-hook-search-"));
  root = await fs.realpath(temporary).then((real) => path.join(real, "ws"));
  cacheDir = path.join(temporary, "cache");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "api.ts"), "export function refreshWorkspace() { return 1; }\nexport function helper() { return 2; }\n");
  await fs.writeFile(path.join(root, "src", "use.ts"), "import { refreshWorkspace } from './api.js';\nexport function first() { return refreshWorkspace(); }\nexport function second() {\n  return refreshWorkspace() + 1;\n}\n");
  await fs.writeFile(path.join(root, "src", "text.ts"), "// cache miss is logged here; refreshWorkspace is not called from this file\nexport const message = 'cache miss';\n");
  await fs.mkdir(path.join(root, "src", "callers"));
  for (let i = 0; i < 20; i += 1) {
    await fs.writeFile(path.join(root, "src", "callers", `c${i}.ts`), `import { refreshWorkspace } from '../api.js';\nexport function caller${i}WithADescriptiveName(argumentOne: number, argumentTwo: string): number {\n  return refreshWorkspace() + argumentOne + argumentTwo.length;\n}\n`);
  }
  for (let i = 0; i < 6; i += 1) await fs.writeFile(path.join(root, "src", `g${i}.ts`), `export class C${i} { get(): number { return ${i}; } }\n`);
  const { buildIndex } = await import("../src/index.js");
  await buildIndex(root, { cacheDir });
});
afterAll(async () => { await fs.rm(temporary, { recursive: true, force: true }); });

async function search(toolName: string, toolInput: Record<string, unknown>, sessionId = "s1", cwd = root): Promise<string> {
  const out: string[] = [];
  const code = await runCli(["hook", "search", "--cache-dir", cacheDir], {
    stdout: (t) => out.push(t), stderr: () => {},
    stdin: async () => JSON.stringify({ session_id: sessionId, cwd, hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput }),
  });
  expect(code).toBe(0);
  return out.join("\n");
}

describe("osnova hook search (PreToolUse)", () => {
  it("denies a grep for an indexed symbol and hands back the graph answer in the reason", async () => {
    const out = await search("Bash", { command: 'rg -n "refreshWorkspace" src' }, "deny-1");
    const decision = JSON.parse(out).hookSpecificOutput;
    expect(decision.hookEventName).toBe("PreToolUse");
    expect(decision.permissionDecision).toBe("deny");
    const reason: string = decision.permissionDecisionReason;
    expect(reason).toContain("src/api.ts:1");
    expect(reason).toMatch(/called from 22 sites in 21 files: src\/use\.ts:2,4 · /);
    expect(reason).toContain("imported by 21 sites in 21 files");
    expect(reason).toMatch(/other text matches[^\n]*\n {2}at 1 site in 1 file: src\/text\.ts:1/);
    expect(reason).toContain("Repeat the identical command to run the search");
    expect(reason.length).toBeLessThanOrEqual(hookSearchCodeUnits);
  });

  it("lets the identical command through the second time in a session", async () => {
    const input = { command: "grep -rn refreshWorkspace src" };
    expect(await search("Bash", input, "repeat")).toContain('"deny"');
    expect(await search("Bash", input, "repeat")).toBe("");
    expect(await search("Bash", input, "another-session")).toContain('"deny"');
  });

  it("answers the Grep tool the same way", async () => {
    const out = await search("Grep", { pattern: "\\brefreshWorkspace\\b", path: "src", output_mode: "content" }, "grep-tool");
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("keeps only the sites inside the searched path", async () => {
    const reason = JSON.parse(await search("Bash", { command: "rg refreshWorkspace src/callers" }, "scoped")).hookSpecificOutput.permissionDecisionReason as string;
    expect(reason).toContain("defined outside the searched paths (src/api.ts#refreshWorkspace)");
    expect(reason).toContain("called from 20 sites in 20 files");
    expect(reason).not.toContain("src/use.ts");
  });

  it("lets a search run when its output is already smaller than the answer", async () => {
    expect(await search("Bash", { command: "rg -n refreshWorkspace src/api.ts" }, "tiny")).toBe("");
  });

  it("lets a definition-only search run: grep prints one line, the graph answer would be larger", async () => {
    expect(await search("Bash", { command: 'rg -n "function refreshWorkspace" src' }, "definition-only")).toBe("");
  });

  it.each([
    ["plain text", "Bash", { command: 'rg -n "cache miss" src' }],
    ["a file list", "Bash", { command: "rg -l refreshWorkspace src" }],
    ["a count", "Bash", { command: "grep -rc refreshWorkspace src" }],
    ["lines with context", "Bash", { command: "rg -n -A 20 refreshWorkspace src" }],
    ["the Grep tool's default file list", "Grep", { pattern: "refreshWorkspace", path: "src" }],
    ["a name nothing defines", "Bash", { command: "rg -n notDefinedAnywhere src" }],
    ["a name with more than five definitions", "Bash", { command: "rg -n get src" }],
    ["a pipe filter", "Bash", { command: "cat src/use.ts | grep refreshWorkspace" }],
    ["a variable path", "Bash", { command: "rg refreshWorkspace $ROOT/src" }],
    ["a path outside the workspace", "Bash", { command: "rg refreshWorkspace /etc" }],
    ["a path that does not exist", "Bash", { command: "rg refreshWorkspace nowhere" }],
    ["a search bundled with other work", "Bash", { command: "rg refreshWorkspace src && sed -n 1,3p src/api.ts" }],
    ["another tool", "Read", { file_path: "src/api.ts" }],
  ])("allows %s", async (_label, tool, input) => {
    expect(await search(tool, input as Record<string, unknown>, `allow-${_label}`)).toBe("");
  });

  it("allows everything when there is no index or the payload is broken", async () => {
    const empty = path.join(temporary, "empty"); await fs.mkdir(empty, { recursive: true });
    expect(await search("Bash", { command: "rg refreshWorkspace" }, "no-index", empty)).toBe("");
    const out: string[] = [];
    await runCli(["hook", "search", "--cache-dir", cacheDir], { stdout: (t) => out.push(t), stderr: () => {}, stdin: async () => "{not json" });
    expect(out).toEqual([]);
  });

  it("is installed for Claude Code by default and in the shipped plugin hooks", async () => {
    const out: string[] = [];
    await runCli(["hook", "install-preview", "--command", "osnova"], { stdout: (t) => out.push(t), stderr: () => {} });
    const snippet = JSON.parse(out.join("\n").split("\n").slice(2).join("\n"));
    expect(snippet.hooks.PreToolUse[0].matcher).toBe("Grep|Bash");
    expect(snippet.hooks.PreToolUse[0].hooks[0].command).toBe("osnova hook search");
    const shipped = JSON.parse(await fs.readFile(path.join(__dirname, "..", "integrations", "claude-code", "hooks", "hooks.json"), "utf8"));
    expect(shipped.hooks.PreToolUse[0].hooks[0].command).toContain("hook search");
  });
});
