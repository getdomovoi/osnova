// Osnova plugin for OpenCode and Kilo: the tool contract in the system prompt, starting points on
// every user message. All logic lives in `osnova hook`; this file only shells out to it. Install by
// copying it into ~/.config/opencode/plugins/ (or ~/.config/kilo/plugins/), or run
// `osnova setup --apply --client opencode --plugin`. Set OSNOVA_BIN to run another osnova executable.
import { spawn } from "node:child_process";

const executable = process.env.OSNOVA_BIN ?? "osnova";

function hook(event, payload, cwd, ...flags) {
  return new Promise((resolve) => {
    let out = "";
    try {
      const child = spawn(executable, ["hook", event, ...flags], { cwd, stdio: ["pipe", "pipe", "ignore"] });
      const timer = setTimeout(() => { child.kill(); resolve(""); }, 15_000);
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.on("error", () => { clearTimeout(timer); resolve(""); });
      child.on("close", () => { clearTimeout(timer); resolve(out.trim()); });
      child.stdin.end(JSON.stringify(payload));
    } catch { resolve(""); }
  });
}

export const OsnovaPlugin = async ({ directory, worktree }) => {
  const cwd = worktree || directory || process.cwd();
  let contract;
  return {
    "experimental.chat.system.transform": async (_input, output) => {
      contract ??= await hook("session", { cwd }, cwd, "--full-contract");
      if (contract.length > 0) output.system.push(contract);
    },
    // A grep or rg for an indexed code name gets the graph answer instead, when that answer is smaller than
    // the search output: a shell search prints the answer, the grep tool is refused with it.
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "grep" && input.tool !== "bash") return;
      const raw = await hook("search", { session_id: input.sessionID, cwd, tool_name: input.tool, tool_input: output.args }, cwd);
      if (raw.length === 0) return;
      let decision;
      try { decision = JSON.parse(raw).hookSpecificOutput; } catch { return; }
      // A shell search is rewritten to print the answer; a grep tool call is refused with the answer.
      if (decision?.updatedInput !== undefined && typeof decision.updatedInput.command === "string") { output.args.command = decision.updatedInput.command; return; }
      if (typeof decision?.permissionDecisionReason === "string" && decision.permissionDecision === "deny") throw new Error(decision.permissionDecisionReason);
    },
    "chat.message": async (_input, output) => {
      const text = output.parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
      if (text.trim().length === 0) return;
      const points = await hook("prompt", { prompt: text, cwd }, cwd);
      if (points.length === 0) return;
      const last = output.parts.filter((part) => part.type === "text").at(-1);
      if (last !== undefined) last.text = `${last.text}\n\n${points}`;
    },
  };
};

export default OsnovaPlugin;
