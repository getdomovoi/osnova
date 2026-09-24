import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

let temporary: string;
let plugin: { "tool.execute.before": (input: { tool: string; sessionID?: string }, output: { args: Record<string, unknown> }) => Promise<void> };

beforeAll(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-opencode-search-"));
  // A stand-in osnova: `hook search` denies any payload whose command mentions refreshWorkspace, and records what it read.
  const stub = path.join(temporary, "osnova");
  await fs.writeFile(stub, `#!/usr/bin/env node
let raw = "";
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  require("node:fs").appendFileSync(${JSON.stringify(path.join(temporary, "seen.jsonl"))}, raw + "\\n");
  if (process.argv[2] === "hook" && process.argv[3] === "search" && raw.includes("refreshWorkspace")) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "[osnova] graph answer for refreshWorkspace" } }));
  }
});
`);
  await fs.chmod(stub, 0o755);
  process.env.OSNOVA_BIN = stub;
  const module = await import("../integrations/opencode/osnova.js");
  plugin = await module.OsnovaPlugin({ directory: temporary });
});
afterAll(async () => {
  delete process.env.OSNOVA_BIN;
  await fs.rm(temporary, { recursive: true, force: true });
});

describe("the OpenCode and Kilo plugin guards searches", () => {
  it("throws the graph answer for a search the hook denies", async () => {
    await expect(plugin["tool.execute.before"]({ tool: "bash", sessionID: "s" }, { args: { command: "rg -n refreshWorkspace src" } })).rejects.toThrow("[osnova] graph answer for refreshWorkspace");
    const seen = (await fs.readFile(path.join(temporary, "seen.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(seen.at(-1)).toMatchObject({ session_id: "s", tool_name: "bash", tool_input: { command: "rg -n refreshWorkspace src" } });
  });

  it("lets other searches and other tools run", async () => {
    await expect(plugin["tool.execute.before"]({ tool: "grep", sessionID: "s" }, { args: { pattern: "cache miss" } })).resolves.toBeUndefined();
    await expect(plugin["tool.execute.before"]({ tool: "read", sessionID: "s" }, { args: { filePath: "refreshWorkspace.ts" } })).resolves.toBeUndefined();
  });
});
