import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { planHooks } from "../src/diagnostics/setup-apply.js";
import { gateChecks } from "../src/diagnostics/doctor.js";

// Installing the gate: into a fresh home, into a home that already has other hooks, and never twice.
// Every path here is a temporary home; the real ~/.claude/settings.json is never opened.

async function home(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "osnova-gate-home-"));
}

async function settings(dir: string, body: unknown): Promise<string> {
  const file = path.join(dir, ".claude", "settings.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(body, null, 2));
  return file;
}

describe("gate installation", () => {
  it("installs the gate and its mark by default for claude-code", async () => {
    const dir = await home();
    const planned = await planHooks({ home: dir, client: "claude-code" });
    expect(planned.action).toBe("create");
    const merged = JSON.parse(planned.merged) as { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };
    expect(merged.hooks.PreToolUse?.[0]?.matcher).toBe("Grep|Glob|Bash");
    expect(merged.hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe("osnova hook gate");
    expect(merged.hooks.PostToolUse?.[0]?.matcher).toBe("mcp__.*osnova.*");
    expect(merged.hooks.PostToolUse?.[0]?.hooks[0]?.command).toBe("osnova hook mark");
  });

  it("leaves the gate out when asked, and says why for a client that cannot deny", async () => {
    const off = await planHooks({ home: await home(), client: "claude-code", gate: false });
    expect(JSON.parse(off.merged).hooks.PreToolUse).toBeUndefined();
    const codex = await planHooks({ home: await home(), client: "codex" });
    expect(JSON.parse(codex.merged).hooks.PreToolUse).toBeUndefined();
    expect(codex.notice).toContain("no pre-tool hook that can deny");
  });

  it("keeps other hooks and adds nothing on a second run", async () => {
    const dir = await home();
    const first = await planHooks({ home: dir, client: "claude-code" });
    await fs.writeFile(await settings(dir, JSON.parse(first.merged)), first.merged);
    const again = await planHooks({ home: dir, client: "claude-code" });
    expect(again.action).toBe("unchanged");
    expect(again.diff).toBe("");
  });

  it("merges into an existing PreToolUse array without dropping the entry already there", async () => {
    const dir = await home();
    await settings(dir, { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "other-tool check" }] }] } });
    const planned = await planHooks({ home: dir, client: "claude-code" });
    const merged = JSON.parse(planned.merged) as { hooks: { PreToolUse: { hooks: { command: string }[] }[] } };
    const commands = merged.hooks.PreToolUse.flatMap((group) => group.hooks.map((hook) => hook.command));
    expect(commands).toContain("other-tool check");
    expect(commands).toContain("osnova hook gate");
  });

  it("installs no gate beside a hand-written one and names it", async () => {
    const dir = await home();
    await settings(dir, { hooks: { PreToolUse: [{ matcher: "Grep|Glob|Bash", hooks: [{ type: "command", command: "node ~/.claude/hooks/osnova-first.js" }] }] } });
    const planned = await planHooks({ home: dir, client: "claude-code" });
    const merged = JSON.parse(planned.merged) as { hooks: { PreToolUse: { hooks: { command: string }[] }[] } };
    expect(merged.hooks.PreToolUse.flatMap((group) => group.hooks.map((hook) => hook.command))).not.toContain("osnova hook gate");
    expect(planned.notice).toContain("osnova-first.js");
  });
});

describe("doctor gate check", () => {
  it("reports the gate as installed, as missing, and as broken without its mark", async () => {
    const installed = await home();
    await settings(installed, JSON.parse((await planHooks({ home: installed, client: "claude-code" })).merged));
    expect((await gateChecks(installed)).find((check) => check.id === "gate:claude-code")).toMatchObject({ status: "ok" });

    const missing = await home();
    await settings(missing, { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "osnova hook prompt" }] }] } });
    const absent = (await gateChecks(missing)).find((check) => check.id === "gate:claude-code");
    expect(absent?.status).toBe("warning");
    expect(absent?.message).toContain("no gate");

    const unmarked = await home();
    await settings(unmarked, { hooks: { PreToolUse: [{ matcher: "Grep|Glob|Bash", hooks: [{ type: "command", command: "osnova hook gate" }] }] } });
    const broken = (await gateChecks(unmarked)).find((check) => check.id === "gate:claude-code");
    expect(broken?.status).toBe("error");
    expect(broken?.message).toContain("every search stays blocked");
  });
});
