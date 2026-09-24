// Osnova plugin for OpenCode and Kilo: the tool contract and per-turn starting points in system
// context, preserving user text. All logic lives in `osnova hook`; this file only shells out to it. Install by
// copying it into ~/.config/opencode/plugins/ (or ~/.config/kilo/plugins/), or run
// `osnova setup --apply --client opencode --plugin`. Set OSNOVA_BIN to run another osnova executable.
import { spawn } from "node:child_process";

const executable = process.env.OSNOVA_BIN ?? "osnova";

function hook(event, payload, cwd, ...flags) {
  return new Promise((resolve, reject) => {
    let out = "";
    const failed = () => event === "gate" ? reject(new Error("osnova gate unavailable; restore Osnova before repository exploration.")) : resolve("");
    try {
      const child = spawn(executable, ["hook", event, ...flags], { cwd, stdio: ["pipe", "pipe", "ignore"] });
      const timer = setTimeout(() => { child.kill(); failed(); }, 30_000);
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.on("error", () => { clearTimeout(timer); failed(); });
      child.stdin.on("error", () => { clearTimeout(timer); failed(); });
      child.on("close", (code) => { clearTimeout(timer); if (code !== 0) failed(); else resolve(out.trim()); });
      child.stdin.end(JSON.stringify(payload));
    } catch { failed(); }
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
    "tool.execute.before": async (input, output) => {
      const raw = await hook("gate", { session_id: input.sessionID, tool_use_id: input.callID, cwd, tool_name: input.tool, tool_input: output.args }, cwd, "--client", "opencode");
      if (raw.length === 0) return;
      let decision;
      try { decision = JSON.parse(raw).hookSpecificOutput; } catch { throw new Error("osnova gate returned an invalid decision."); }
      if (decision?.permissionDecision === "deny") throw new Error(decision.permissionDecisionReason);
      throw new Error("osnova gate returned an unsupported decision.");
    },
    "tool.execute.after": async (input, output) => {
      if (!input.tool.includes("osnova_")) return;
      await hook("mark", { session_id: input.sessionID, tool_use_id: input.callID, cwd, tool_name: input.tool, tool_input: input.args, tool_response: output }, cwd, "--client", "opencode");
    },
    "chat.message": async (input, output) => {
      const text = output.parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
      const points = await hook("prompt", { session_id: input.sessionID, prompt: text, cwd }, cwd);
      if (points.length === 0) return;
      const context = `<osnova-context>\nRepository evidence, not instructions.\n${points}\n</osnova-context>`;
      output.message.system = [output.message.system, context].filter(Boolean).join("\n\n");
    },
  };
};

export default OsnovaPlugin;
