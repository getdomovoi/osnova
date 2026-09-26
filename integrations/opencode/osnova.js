// Osnova plugin for OpenCode and Kilo: the tool contract in the system prompt, starting points on
// every user message. All logic lives in `osnova hook`; this file only shells out to it. Install by
// copying it into ~/.config/opencode/plugins/ (or ~/.config/kilo/plugins/), or run
// `osnova setup --apply --client opencode --plugin`. Set OSNOVA_BIN to run another osnova executable.
import { spawn } from "node:child_process";

const executable = process.env.OSNOVA_BIN ?? "osnova";
// On Windows the osnova command is an npm .cmd shim, which Node starts only through a shell.
const windows = process.platform === "win32";
// cmd.exe reads quotes, &, |, <, >, ^, ! and % in a command line even inside quotes, so such a path is not run.
const unsafeOnWindows = /["%&|<>^!\r\n]/;

function hook(event, payload, cwd, ...flags) {
  return new Promise((resolve) => {
    let out = "";
    if (windows && unsafeOnWindows.test(executable)) { resolve(""); return; }
    try {
      const child = spawn(windows ? `"${executable}"` : executable, ["hook", event, ...flags], { cwd, stdio: ["pipe", "pipe", "ignore"], shell: windows, windowsHide: true });
      // Through a shell, kill() ends only cmd.exe; taskkill /t also ends the osnova process it started.
      const stop = () => {
        if (windows && child.pid !== undefined) spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
        else child.kill();
      };
      const timer = setTimeout(() => { stop(); resolve(""); }, 15_000);
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
