import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { refreshWorkspace, indexGeneration } from "../src/api.js";
import { gateClients, markGate, resetGate, strictGate, strictSubject } from "../src/cli/strict-gate.js";
import { runCli } from "../src/cli/cli.js";
import { workspaceDirFor } from "../src/cache/cache.js";

let temporary: string, workspace: string, cacheDir: string;
beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-strict-"));
  workspace = path.join(temporary, "workspace");
  cacheDir = path.join(temporary, "cache");
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.writeFile(path.join(workspace, "src", "a.ts"), "export function alpha() { return 1; }\n");
  await fs.writeFile(path.join(workspace, "src", "b.ts"), "export function beta() { return 2; }\n");
  await fs.writeFile(path.join(workspace, "AGENTS.md"), "Read these rules first.\n");
});
afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }); });

const input = (toolName: string, toolInput: Record<string, unknown>, sessionId = "one") => ({ sessionId, toolName, toolInput });
async function answer(file = "src/a.ts"): Promise<string> {
  const index = await refreshWorkspace(workspace, { cacheDir });
  return `osnova generation ${indexGeneration(index).slice(0, 16)}\nfunction ${file}#alpha ${file}:1`;
}
async function mark(text: unknown, sessionId = "one"): Promise<void> {
  await markGate({ ...input("mcp__osnova__osnova_ground", {}, sessionId), toolResponse: text }, workspace, cacheDir);
}

describe("strict exploration gate", () => {
  it("denies a cold source read without building the index inside the hook", async () => {
    const artifact = path.join(workspaceDirFor(cacheDir, await fs.realpath(workspace)), "index.sha");
    expect(await strictGate(input("Read", { file_path: "src/a.ts" }), workspace, cacheDir)).toContain("osnova gate:");
    await expect(fs.access(artifact)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("explains directory discovery separately from missing file evidence without changing grants", async () => {
    const read = input("Read", { file_path: "src/a.ts" });
    expect(await strictGate(read, workspace, cacheDir)).toContain("source file has no current grant");
    await mark(await answer());
    expect(await strictGate(read, workspace, cacheDir)).toBeNull();
    const calls = [input("Bash", { command: "ls; cat package.json 2>/dev/null" }),
      input("Read", { file_path: "." }), input("Glob", { pattern: "**/*.ts" })];
    for (const call of calls) {
      const reason = await strictGate(call, workspace, cacheDir);
      expect(reason).toContain("repository discovery or unscoped source command blocked");
      expect(reason).toContain("Queries never grant directory listings");
      expect(reason).toContain("do not retry discovery through another tool/interpreter");
    }
    expect(await strictGate(input("Bash", { command: "cat package.json" }), workspace, cacheDir)).toBeNull();
    expect(await strictGate(input("Bash", { command: "pnpm test" }), workspace, cacheDir)).toBeNull();
    await fs.appendFile(path.join(workspace, "src/a.ts"), "export const changed = 1;\n");
    expect(await strictGate(read, workspace, cacheDir)).toContain("indexed file has no current grant");
  });
  it("does not reindex unrelated edits while marking or reading a granted file", async () => {
    const text = await answer();
    const artifact = path.join(workspaceDirFor(cacheDir, await fs.realpath(workspace)), "index.sha");
    const generation = await fs.readFile(artifact, "utf8");
    await fs.appendFile(path.join(workspace, "src/b.ts"), "export const changed = 1;\n");
    await mark(text);
    expect(await strictGate(input("Read", { file_path: "src/a.ts" }), workspace, cacheDir)).toBeNull();
    expect(await fs.readFile(artifact, "utf8")).toBe(generation);
    expect(await strictGate(input("Read", { file_path: "src/b.ts" }), workspace, cacheDir)).not.toBeNull();
  });

  it("does not reindex source changes to permit an unsupported regular file", async () => {
    await answer();
    const artifact = path.join(workspaceDirFor(cacheDir, await fs.realpath(workspace)), "index.sha");
    const generation = await fs.readFile(artifact, "utf8");
    await fs.appendFile(path.join(workspace, "src/b.ts"), "export const changed = 1;\n");
    expect(await strictGate(input("Read", { file_path: "AGENTS.md" }), workspace, cacheDir)).toBeNull();
    expect(await fs.readFile(artifact, "utf8")).toBe(generation);
  });

  it("denies known indexed files and directories without rescanning unrelated edits", async () => {
    await answer();
    const artifact = path.join(workspaceDirFor(cacheDir, await fs.realpath(workspace)), "index.sha");
    const generation = await fs.readFile(artifact, "utf8");
    await fs.appendFile(path.join(workspace, "src/b.ts"), "export const changed = 1;\n");
    expect(await strictGate(input("Read", { file_path: "src/a.ts" }), workspace, cacheDir)).not.toBeNull();
    expect(await strictGate(input("Read", { file_path: "src" }), workspace, cacheDir)).not.toBeNull();
    expect(await fs.readFile(artifact, "utf8")).toBe(generation);
  });

  it("clears a cold source denial when the completed index excludes that file", async () => {
    await fs.writeFile(path.join(workspace, ".osnovaignore"), "src/b.ts\n");
    expect(await strictGate(input("Read", { file_path: "src/b.ts" }), workspace, cacheDir)).not.toBeNull();
    await mark(await answer());
    expect(await strictGate(input("Bash", { command: "pnpm test" }), workspace, cacheDir)).toBeNull();
  });

  it("rejects changed query sources and same-size edits with restored modification time", async () => {
    const text = await answer();
    const file = path.join(workspace, "src/a.ts");
    const original = await fs.readFile(file, "utf8");
    const stat = await fs.stat(file);
    await fs.writeFile(file, original.replace("return 1", "return 9"));
    await fs.utimes(file, stat.atime, stat.mtime);
    await mark(text);
    expect(await strictGate(input("Read", { file_path: "src/a.ts" }), workspace, cacheDir)).not.toBeNull();
    expect(await strictGate(input("Bash", { command: "node -e 'process.exit(0)'" }), workspace, cacheDir)).toContain("completed Osnova query");
    await mark(await answer());
    expect(await strictGate(input("Read", { file_path: "src/a.ts" }), workspace, cacheDir)).toBeNull();
    await fs.writeFile(file, original);
    await fs.utimes(file, stat.atime, stat.mtime);
    expect(await strictGate(input("Read", { file_path: "src/a.ts" }), workspace, cacheDir)).not.toBeNull();
  });

  it.each([
    ["Grep", { pattern: "alpha" }], ["Glob", { pattern: "**/*.ts" }],
    ["read", { filePath: "src/a.ts" }], ["Read", { file_path: "src/a.ts" }],
    ["mcp__fs__read_file", { path: "src/a.ts" }], ["codebase_search", { query: "alpha" }],
    ["Bash", { command: "rg alpha src" }], ["shell", { command: "find src -name '*.ts'" }],
    ["exec_command", { cmd: "cat src/a.ts" }], ["Bash", { command: "sed -n '1,20p' src/a.ts" }],
    ["Bash", { command: "osnova ground alpha; rg beta src" }],
    ["Bash", { command: "env X=1 /usr/bin/rg alpha src" }],
    ["Bash", { command: "sh -c 'rg alpha src'" }],
    ["Bash", { command: "rg alpha src/a.ts | grep beta src/b.ts" }],
    ["Bash", { command: "rg alpha - < src/b.ts src/a.ts" }],
    ["Glob", { path: "logs", pattern: "../src/**/*.ts" }],
    ["Bash", { command: "cat 'src/b.ts' src/a.ts" }],
  ])("blocks %s exploration before a query", async (name, args) => {
    expect(await strictGate(input(name, args), workspace, cacheDir)).toContain("osnova gate:");
  });

  it("grants only named files, preserves the broad-search block and isolates sessions", async () => {
    const read = input("Read", { file_path: "src/a.ts" });
    await mark({ content: [{ type: "text", text: await answer() }] });
    expect(await strictGate(read, workspace, cacheDir)).toBeNull();
    expect(await strictGate(input("Bash", { command: "rg alpha src/a.ts" }), workspace, cacheDir)).toBeNull();
    expect(await strictGate(input("Bash", { command: "sed -n '1,20p' src/a.ts" }), workspace, cacheDir)).toBeNull();
    expect(await strictGate(input("Bash", { command: "head -n 10 'src/a.ts'" }), workspace, cacheDir)).toBeNull();
    expect(await strictGate(input("Bash", { command: "cat 'src/b.ts' src/a.ts" }), workspace, cacheDir)).not.toBeNull();
    expect(await strictGate(input("Bash", { command: "sed -n '1e cat src/b.ts' src/a.ts" }), workspace, cacheDir)).not.toBeNull();
    expect(await strictGate(input("Read", { file_path: "src/b.ts" }), workspace, cacheDir)).not.toBeNull();
    expect(await strictGate(input("Grep", { pattern: "alpha", path: "src" }), workspace, cacheDir)).not.toBeNull();
    expect(await strictGate({ ...read, sessionId: "two" }, workspace, cacheDir)).not.toBeNull();
    expect(await strictGate({ ...read, agentId: "child" }, workspace, cacheDir)).not.toBeNull();
    expect(await strictGate({ ...read, sessionId: undefined }, workspace, cacheDir)).not.toBeNull();
  });

  it("revokes permissions on the next prompt and when the file changes", async () => {
    const read = input("Read", { file_path: "src/a.ts" });
    await mark(await answer());
    expect(await strictGate(input("Bash", { command: "node -e 'process.exit(0)'" }), workspace, cacheDir)).toBeNull();
    await resetGate(read, workspace, cacheDir);
    expect(await strictGate(read, workspace, cacheDir)).not.toBeNull();
    expect(await strictGate(input("Bash", { command: "node -e 'process.exit(0)'" }), workspace, cacheDir)).toContain("completed Osnova query");
    await mark(await answer());
    expect(await strictGate(read, workspace, cacheDir)).toBeNull();
    await fs.writeFile(path.join(workspace, "src", "a.ts"), "export function alpha() { return 333; }\n");
    expect(await strictGate(read, workspace, cacheDir)).not.toBeNull();
  });

  it("isolates supplied turn ids, including late results from an earlier turn", async () => {
    const text = await answer();
    const first = { ...input("osnova_ground", {}), turnId: "first", toolResponse: text };
    const read = { ...input("Read", { file_path: "src/a.ts" }), turnId: "first" };
    await markGate(first, workspace, cacheDir);
    expect(await strictGate(read, workspace, cacheDir)).toBeNull();
    expect(await strictGate({ ...read, turnId: "second" }, workspace, cacheDir)).not.toBeNull();
    await resetGate({ ...read, turnId: "second" }, workspace, cacheDir);
    await markGate(first, workspace, cacheDir);
    expect(await strictGate({ ...read, turnId: "second" }, workspace, cacheDir)).not.toBeNull();
    expect(await strictGate({ ...read, turnId: undefined }, workspace, cacheDir)).not.toBeNull();
    await markGate({ ...first, turnId: "second" }, workspace, cacheDir);
    expect(await strictGate({ ...read, turnId: "second" }, workspace, cacheDir)).toBeNull();
  });

  it("ignores failed, missing, stale and unrelated results", async () => {
    const text = await answer();
    for (const response of [undefined, { isError: true, content: [{ text }] }, { error: "failed", output: text }, text.replace(/generation \w+/, "generation stale"), "src/a.ts:1"]) {
      await mark(response);
      expect(await strictGate(input("Read", { file_path: "src/a.ts" }), workspace, cacheDir)).not.toBeNull();
    }
    await markGate({ ...input("mcp__other__osnova_fake", {}), toolResponse: text }, workspace, cacheDir);
    expect(await strictGate(input("Read", { file_path: "src/a.ts" }), workspace, cacheDir)).not.toBeNull();
  });

  it("permits an exact-file fallback after an empty successful outline, never a directory scope", async () => {
    const text = (await answer()).split("\n")[0]!;
    await markGate({ ...input("osnova_outline", { file: "src/a.ts" }), toolResponse: `${text}\nno definitions` }, workspace, cacheDir);
    expect(await strictGate(input("Read", { file_path: "src/a.ts" }), workspace, cacheDir)).toBeNull();
    await markGate({ ...input("osnova_thread", { in: "src" }), toolResponse: `${text}\nno matches` }, workspace, cacheDir);
    expect(await strictGate(input("Read", { file_path: "src/b.ts" }), workspace, cacheDir)).not.toBeNull();
  });

  it("keeps parallel query receipts without unlocking a different workspace", async () => {
    await Promise.all([mark(await answer()), mark(await answer("src/b.ts"))]);
    expect(await strictGate(input("Read", { file_path: "src/b.ts" }), workspace, cacheDir)).toBeNull();
    const other = path.join(temporary, "other");
    await fs.mkdir(path.join(other, "src"), { recursive: true });
    await fs.copyFile(path.join(workspace, "src", "a.ts"), path.join(other, "src", "a.ts"));
    expect(await strictGate(input("Read", { file_path: "src/a.ts" }), other, cacheDir)).not.toBeNull();
  });

  it("allows instructions, unindexed paths, edits, passive operations and Osnova itself", async () => {
    for (const call of [input("Read", { file_path: "AGENTS.md" }), input("Read", { file_path: "trace.log" }), input("Grep", { path: path.join(temporary, "logs"), pattern: "x" }), input("Edit", { file_path: "src/a.ts" }), input("Bash", { command: "git status | grep modified" }), input("mcp__osnova__osnova_footing", { question: "alpha" })]) {
      expect(await strictGate(call, workspace, cacheDir)).toBeNull();
    }
    expect(await strictGate(input("Bash", { command: "pnpm test" }), workspace, cacheDir)).toContain("completed Osnova query");
  });

  it("blocks searches through a parent directory and a symlink into indexed code", async () => {
    expect(await strictGate(input("Bash", { command: "rg alpha .." }), workspace, cacheDir)).not.toBeNull();
    const link = path.join(temporary, "alias");
    await fs.symlink(path.join(workspace, "src"), link, "junction");
    expect(await strictGate(input("Grep", { pattern: "alpha", path: link }), workspace, cacheDir)).not.toBeNull();
  });

  it("denies recognized exploration when index verification fails", async () => {
    await fs.writeFile(cacheDir, "not a directory");
    const out: string[] = [], errors: string[] = [];
    await runCli(["hook", "gate", "--workspace", workspace, "--cache-dir", cacheDir], { stdin: async () => JSON.stringify({ tool_name: "Read", tool_input: { file_path: "src/a.ts" } }), stdout: (text) => out.push(text), stderr: (text) => errors.push(text) });
    expect(JSON.parse(out.join("")).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("keeps passive operations and external log reads available with a broken cache", async () => {
    await fs.writeFile(cacheDir, "not a directory");
    for (const command of ["gh pr checks 95", "git status --short", "gh pr checks 95 2>&1 | tail -1", "cd src; git status --short | grep -v '^??'", `tail -n 30 '${temporary}/test.log'`, `cat '${temporary}/test.log' | grep -i fail`]) {
      expect(await strictGate(input("Bash", { command }), workspace, cacheDir), command).toBeNull();
    }
    for (const command of ["task api:test", "task api:test | head -n 10"]) {
      await expect(strictGate(input("Bash", { command }), workspace, cacheDir)).rejects.toThrow("ENOTDIR");
    }
  });

  it("allows scratchpad listings in status pipelines without granting source exploration", async () => {
    const scratchpad = path.join(temporary, "scratchpad");
    await fs.mkdir(scratchpad);
    await fs.writeFile(cacheDir, "not a directory");
    for (const command of [
      `ls -t '${scratchpad}/' | head -5`,
      `cd '${workspace}' && git status --short && git branch --show-current && git log --oneline -3 && ls -t '${scratchpad}/' | head -5`,
      `cd '${scratchpad}' && ls -lt | head -5`,
    ]) expect(await strictGate(input("Bash", { command }), workspace, cacheDir), command).toBeNull();
    await fs.unlink(cacheDir);
    for (const command of [
      "ls -t src | head -5", "ls | head -5", `ls -t '${scratchpad}' src | head -5`,
      `git status --short && ls '${scratchpad}' && rg alpha src`,
      `ls '${scratchpad}' | head -5 src/a.ts`,
    ]) expect(await strictGate(input("Bash", { command }), workspace, cacheDir), command).not.toBeNull();
  });

  it("checks every file operand in pipelines and after directory changes", async () => {
    await mark(await answer());
    for (const command of ["git status | tail -1 src/b.ts", "gh pr checks | grep -f src/b.ts", "gh pr checks | rg --files", "cat src/a.ts | grep beta src/b.ts", "cd src; cat b.ts", "gh pr checks | tail -1; cat src/b.ts", "git status | tail -1 < src/b.ts", "git status | sed -n '1e cat src/b.ts'"]) {
      expect(await strictGate(input("Bash", { command }), workspace, cacheDir), command).not.toBeNull();
    }
    expect(await strictGate(input("Bash", { command: "cd src; cat a.ts | tail -1" }), workspace, cacheDir)).toBeNull();
  });

  it("keeps print-only pipeline filters scoped to the granted input file", async () => {
    await mark(await answer());
    for (const command of ["nl -ba src/a.ts | sed -n '1,5p'", "rg alpha src/a.ts | sed -n '1,5p'", "sed -n '1,5p' src/a.ts | cat -n"]) {
      expect(await strictGate(input("Bash", { command }), workspace, cacheDir), command).toBeNull();
    }
    expect(await strictGate(input("Bash", { command: "nl -ba src/a.ts | sed -n '1e cat src/b.ts'" }), workspace, cacheDir)).not.toBeNull();
  });

  it("expands a home-relative pipeline target before checking indexed scope", () => {
    expect(strictSubject(input("Bash", { command: "rg alpha ~/projects/osnova/src | head -10" }), workspace)).toEqual({
      targets: [path.join(os.homedir(), "projects/osnova/src")], cwd: workspace,
    });
  });

  it("keeps Git metadata commands available without treating patch output as passive", async () => {
    for (const command of ["git status --short", "git branch --show-current", "git log --oneline -3", "git rev-parse --show-toplevel", "git merge-base HEAD main"]) {
      expect(await strictGate(input("Bash", { command }), workspace, cacheDir), command).toBeNull();
    }
    for (const command of ["git log -p", "git log --patch", "git status -vv"]) {
      expect(await strictGate(input("Bash", { command }), workspace, cacheDir), command).toContain("completed Osnova query");
    }
  });

  it("does not mistake quoted arguments or external redirections for source discovery", async () => {
    await mark(await answer());
    for (const command of [
      "git commit -m 'fix: find callers in tree'",
      "git commit -m \"$(cat <<'EOF'\nfix: find callers\nEOF\n)\"",
      `cat > '${temporary}/note.txt'`,
      "echo 'src/*'",
    ]) expect(await strictGate(input("Bash", { command }), workspace, cacheDir), command).toBeNull();
  });

  it("requires file evidence for Git source reads and listings", async () => {
    await mark(await answer());
    for (const command of ["git show HEAD:src/b.ts", "git ls-tree -r HEAD src", "tac src/b.ts", "bat src/b.ts", "echo src/*"]) {
      expect(await strictGate(input("Bash", { command }), workspace, cacheDir), command).not.toBeNull();
    }
  });

  it("does not grant user-claimed plumb sites", async () => {
    const header = (await answer()).split("\n")[0]!;
    await markGate({ ...input("osnova_plumb", { symbol: "alpha", sites: ["src/b.ts:1"] }), toolResponse: `${header}\nno-call src/b.ts:1` }, workspace, cacheDir);
    expect(await strictGate(input("Read", { file_path: "src/b.ts" }), workspace, cacheDir)).not.toBeNull();
  });

  it("recognizes host discovery names and directory argument keys", async () => {
    for (const call of [input("ls", { path: "src" }), input("list_dir", { dir_path: "src" }), input("grep_grep_search", { pattern: "alpha", path: "src" })]) {
      expect(await strictGate(call, workspace, cacheDir)).not.toBeNull();
    }
  });

  it("does not hide an opaque command beside an external file read", async () => {
    const scratchpad = path.join(temporary, "scratchpad");
    await fs.mkdir(scratchpad);
    for (const command of [`git add src/a.ts; ls '${scratchpad}'`, `node -e 'process.exit(0)' && ls '${scratchpad}'`, `ls '${scratchpad}' | cat; task api:test`]) {
      expect(await strictGate(input("Bash", { command }), workspace, cacheDir), command).toContain("completed Osnova query");
    }
  });

  it("resolves shell working directories before granting file scope", () => {
    expect(strictSubject({ ...input("Bash", { command: "rg alpha a.ts", workdir: "src" }), cwd: workspace }, workspace)).toEqual({ cwd: path.join(workspace, "src"), targets: ["a.ts"] });
  });

  it.each(gateClients)("emits a blocking CLI decision for %s", async (client) => {
    const out: string[] = [];
    const code = await runCli(["hook", "gate", "--client", client, "--workspace", workspace, "--cache-dir", cacheDir], { stdin: async () => JSON.stringify({ tool_name: "Grep", tool_input: { pattern: "alpha" }, session_id: "cli" }), stdout: (text) => out.push(text), stderr: () => undefined });
    expect(code).toBe(0);
    const result = JSON.parse(out.join(""));
    expect(client === "cursor" ? result.permission : client === "pi" ? result.block : result.hookSpecificOutput.permissionDecision).toBe(client === "pi" ? true : "deny");
    const reason = client === "cursor" ? result.agent_message : client === "pi" ? result.reason : result.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain("repository discovery or unscoped source command blocked");
    expect(reason).toContain("Queries never grant directory listings");
  });
});


it.each(["- src/a.tsx", "- other/src/a.ts", "- src", "- src/a.ts omitted", "- src/a.ts/child", "- src/aXts"])("does not grant a file from a different bare path: %s", async (line) => {
  const header = (await answer()).split("\n")[0]!;
  await mark(`${header}\ncandidate tests:\n${line}`);
  expect(await strictGate(input("Read", { file_path: "src/a.ts" }), workspace, cacheDir)).not.toBeNull();
});

it("holds Claude shell launchers behind a completed query, including dynamically generated scripts", async () => {
  const script = path.join(temporary, "run.sh");
  await fs.writeFile(script, "#!/bin/sh\ncommand=$(printf '%s%s' r g)\nexec \"$command\" alpha src/a.ts\n");
  const decision = async (command: string, sessionId = "claude-shell") => {
    const out: string[] = [];
    const code = await runCli(["hook", "gate", "--client", "claude-code", "--workspace", workspace, "--cache-dir", cacheDir], {
      stdin: async () => JSON.stringify({ hook_event_name: "PreToolUse", session_id: sessionId, cwd: workspace,
        tool_use_id: `tool-${command}`, tool_name: "Bash", tool_input: { command, description: "Run a project command" } }),
      stdout: (text) => out.push(text), stderr: () => undefined,
    });
    expect(code).toBe(0);
    return out.length === 0 ? null : JSON.parse(out.join("")) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  };
  expect((await decision("rg alpha src/a.ts"))?.hookSpecificOutput.permissionDecision).toBe("deny");
  const wrappers = [
    `sh ${script}`, `bash ${script}`, `./${path.relative(workspace, script)}`,
    "sh -c 'rg alpha src/a.ts'", "node -e 'require(\"child_process\").execFileSync(\"rg\", [\"alpha\", \"src/a.ts\"])'",
    "python3 -c 'import subprocess; subprocess.run([\"rg\", \"alpha\", \"src/a.ts\"])'",
    `cd src && bash ${script}`, "git add src/a.ts", "task api:test",
  ];
  for (const command of wrappers) {
    expect((await decision(command))?.hookSpecificOutput.permissionDecision, command).toBe("deny");
  }
  expect(await decision("git status --short")).toBeNull();
  await mark(await answer("src/a.ts"), "claude-shell");
  for (const command of wrappers) expect(await decision(command), command).toBeNull();
});

it("keeps a denied source target unresolved when a query grants a different file", async () => {
  const script = path.join(temporary, "denied.sh");
  await fs.writeFile(script, "#!/bin/sh\ncommand=$(printf '%s%s' r g)\nexec \"$command\" beta src/b.ts\n");
  const denied = input("Bash", { command: "rg beta src/b.ts" }, "pending");
  expect(await strictGate(denied, workspace, cacheDir)).not.toBeNull();
  await mark(await answer("src/a.ts"), "pending");
  const wrappers = [
    `sh ${script}`, `bash ${script}`, `./${path.relative(workspace, script)}`,
    "sh -c 'rg beta src/b.ts'", "node -e 'require(\"child_process\").execFileSync(\"rg\", [\"beta\", \"src/b.ts\"])'",
    "python3 -c 'import subprocess; subprocess.run([\"rg\", \"beta\", \"src/b.ts\"])'",
    `cd src && sh ${script}`, "git add src/b.ts", "task api:test",
  ];
  for (const command of wrappers) {
    expect(await strictGate(input("Bash", { command }, "pending"), workspace, cacheDir), command).not.toBeNull();
  }
  await mark(await answer("src/b.ts"), "pending");
  for (const command of wrappers) expect(await strictGate(input("Bash", { command }, "pending"), workspace, cacheDir), command).toBeNull();
});
