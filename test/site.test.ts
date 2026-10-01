import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../src/cli/cli.js";

const root = path.join(import.meta.dirname, "..");
const page = fs.readFileSync(path.join(root, "site", "public", "index.html"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { name: string; engines: { node: string } };
const marketplace = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "marketplace.json"), "utf8")) as { name: string; plugins: { name: string }[] };

function decode(text: string): string {
  return text.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

// Every command on the site sits in a <code> element (one per line) or in backticks inside a prompt.
function shownCommands(): string[] {
  const found = new Set<string>();
  for (const match of page.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g)) {
    for (const line of decode(match[1] ?? "").split("\n")) found.add(line.trim());
  }
  for (const match of decode(page).matchAll(/`([^`\n]+)`/g)) found.add((match[1] ?? "").trim());
  return [...found].filter((line) => line.length > 0).sort();
}

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-site-home-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("marketing site install commands", () => {
  it("shows the setup commands for every client family", () => {
    const setup = shownCommands().filter((line) => line.startsWith("osnova setup "));
    expect(setup).toEqual(expect.arrayContaining([
      "osnova setup claude",
      "osnova setup claude --apply",
      "osnova setup agents --only codex --apply",
      "osnova setup agents --only cursor --apply",
      "osnova setup agents --only opencode --apply",
      "osnova setup agents --only kilo --apply",
      "osnova setup agents --only pi --apply",
    ]));
  });

  it("previews every setup command it shows without error", async () => {
    const setup = shownCommands().filter((line) => line.startsWith("osnova setup "));
    expect(setup.length).toBeGreaterThan(0);
    for (const line of setup) {
      const args = line.split(/\s+/).slice(1).filter((arg) => arg !== "--apply");
      const errors: string[] = [];
      const code = await runCli([...args, "--home", home], { stdout: () => {}, stderr: (text) => errors.push(text) });
      expect({ line, code, errors }).toEqual({ line, code: 0, errors: [] });
    }
  });

  it("names only subcommands the CLI knows", async () => {
    const usage: string[] = [];
    await runCli([], { stdout: (text) => usage.push(text), stderr: (text) => usage.push(text) });
    const known = usage.join("\n");
    const subcommands = new Set(shownCommands().filter((line) => line.startsWith("osnova ")).map((line) => line.split(/\s+/)[1] ?? ""));
    for (const sub of subcommands) expect(known, sub).toContain(`osnova ${sub}`);
  });

  it("installs the published package, plugin and Node.js version", () => {
    const commands = shownCommands();
    for (const line of commands.filter((entry) => entry.startsWith("npm install") || entry.startsWith("npx "))) {
      expect(line).toContain(pkg.name);
    }
    expect(commands).toContain(`npm install -g ${pkg.name}`);
    expect(commands).toContain(`/plugin install ${marketplace.plugins[0]?.name}@${marketplace.name}`);
    expect(decode(page)).toContain(`Node.js ${pkg.engines.node.replace(/^>=/, "").replace(/\.0$/, "")} or newer`);
  });
});
