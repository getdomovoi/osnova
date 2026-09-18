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
      expect(c.out.join("\n")).toContain("[osnova] starting points");
      expect(c.out.join("\n")).toContain("billing.ts#renderInvoice");
      expect(c.out.join("\n").length).toBeLessThanOrEqual(1_024);
      c = capture(JSON.stringify({ prompt: "/clear", cwd: root }));
      expect(await runCli(["hook", "prompt", "--cache-dir", cacheDir], c.io)).toBe(0);
      expect(c.out).toEqual([]);
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
      expect(c.err.join("\n")).toContain("osnova hook:");
      c = capture();
      expect(await runCli(["hook", "install-preview", "--command", "node", "--command", "/opt/osnova/dist/bin.js"], c.io)).toBe(0);
      const snippet = JSON.parse(c.out.join("\n").split("\n").slice(1).join("\n"));
      expect(snippet.hooks.UserPromptSubmit[0].hooks[0].command).toBe("node /opt/osnova/dist/bin.js hook prompt");
      expect(snippet.hooks.SessionStart[0].hooks[0].command).toBe("node /opt/osnova/dist/bin.js hook session");
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  });
});
