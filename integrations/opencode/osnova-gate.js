// Osnova gate plugin for OpenCode and Kilo, opt-in: it denies a search that reaches indexed code until an osnova
// tool or the osnova CLI has run in the turn. All logic lives in `osnova hook gate`; this file only shells out to
// it and lets the tool run whenever osnova does not answer. Install it beside osnova.js with
// `osnova setup --apply --client opencode --plugin --gate`. OSNOVA_GATE=off switches it off; OSNOVA_BIN runs
// another osnova executable.
import { spawn } from "node:child_process";

const executable = process.env.OSNOVA_BIN ?? "osnova";
// On Windows the osnova command is an npm .cmd shim, which Node starts only through a shell.
const windows = process.platform === "win32";
// Inside double quotes cmd.exe reads &, |, <, >, and ^ literally, but a quote ends the quoting and % or ! expands
// a variable, so a path holding one of those, or a line break, is not run.
const unsafeOnWindows = /["%!\r\n]/;
// Tool calls the gate may decide on: search tools, osnova's own tools, and shell commands that search or run osnova.
const searchTool = /^(?:grep|glob)$|osnova_/;
const searchCommand = /(?:^|[\s;&|(])(?:grep|egrep|fgrep|rg|ag|ack|fd|find|git\s+grep|osnova)(?:\s|$)/;

function gate(payload, cwd) {
  return new Promise((resolve) => {
    let out = "";
    if (process.env.OSNOVA_GATE === "off" || (windows && unsafeOnWindows.test(executable))) { resolve(""); return; }
    try {
      const child = spawn(windows ? `"${executable}"` : executable, ["hook", "gate"], { cwd, stdio: ["pipe", "pipe", "ignore"], shell: windows, windowsHide: true });
      // Through a shell, kill() ends only cmd.exe; taskkill /t also ends the osnova process it started.
      const stop = () => {
        if (!windows || child.pid === undefined) { child.kill(); return; }
        // When taskkill cannot start or fails, ending the shell is still better than nothing.
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
        killer.on("error", () => child.kill());
        killer.on("exit", (code) => { if (code !== 0) child.kill(); });
      };
      const timer = setTimeout(() => { stop(); resolve(""); }, 10_000);
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.on("error", () => { clearTimeout(timer); resolve(""); });
      child.on("close", () => { clearTimeout(timer); resolve(out.trim()); });
      child.stdin.end(JSON.stringify({ ...payload, cwd }));
    } catch { resolve(""); }
  });
}

// The deny reason in the gate's answer, or undefined when the tool may run.
function denyReason(answer) {
  try {
    const output = JSON.parse(answer).hookSpecificOutput;
    return output?.permissionDecision === "deny" && typeof output.permissionDecisionReason === "string" ? output.permissionDecisionReason : undefined;
  } catch { return undefined; }
}

export const OsnovaGatePlugin = async ({ directory, worktree }) => {
  const cwd = worktree || directory || process.cwd();
  return {
    "chat.message": async (input) => {
      if (typeof input?.sessionID === "string") await gate({ hook_event_name: "UserPromptSubmit", session_id: input.sessionID }, cwd);
    },
    "tool.execute.before": async (input, output) => {
      const tool = String(input?.tool ?? "");
      const args = output?.args ?? {};
      if (typeof input?.sessionID !== "string") return;
      if (!searchTool.test(tool) && !(tool === "bash" && searchCommand.test(String(args.command ?? "")))) return;
      const reason = denyReason(await gate({ session_id: input.sessionID, tool_name: tool, tool_input: args }, cwd));
      if (reason !== undefined) throw new Error(reason);
    },
  };
};

export default OsnovaGatePlugin;
