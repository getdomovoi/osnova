import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../src/cli/cli.js";
import { renderSitePages } from "../scripts/site-pages.js";
import { agentHarnesses, harnessFolder, planFamily, type AgentHarness, type SetupFamily } from "../src/diagnostics/setup-apply.js";

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

// Each command runs in its own home where every harness counts as installed, so `setup agents --only x` has work to do.
const homes: string[] = [];
function harnessHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-site-home-"));
  for (const harness of agentHarnesses) fs.mkdirSync(harnessFolder(harness, home), { recursive: true });
  homes.push(home);
  return home;
}
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
}

async function cli(args: string[]): Promise<{ code: number; errors: string[] }> {
  const errors: string[] = [];
  const code = await runCli(args, { stdout: () => {}, stderr: (text) => errors.push(text) });
  return { code, errors };
}

// How far the home is from a full install of the command's family: each component still to write
// (kind and path under home), each component setup would keep instead of writing, and each harness it would skip.
async function planState(args: string[], home: string): Promise<{ pending: string[]; kept: string[]; skipped: string[] }> {
  const family = args[1] as SetupFamily;
  const onlyAt = args.indexOf("--only");
  const only = onlyAt === -1 ? undefined : (args[onlyAt + 1] ?? "").split(",") as AgentHarness[];
  const plan = await planFamily(family, { home, only });
  const component = (change: { kind: string; path: string }) => `${change.kind} ${path.relative(home, change.path)}`;
  return {
    pending: plan.changes.filter((change) => change.action !== "unchanged").map(component).sort(),
    kept: plan.kept.map(component).sort(),
    skipped: plan.skipped.map((entry) => entry.harness).sort(),
  };
}

const setupLines = () => shownCommands().filter((line) => line.startsWith("osnova setup "));

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

  it("previews without writing, as the prompts promise", async () => {
    const previews = setupLines().filter((line) => !line.includes("--apply"));
    expect(previews.length).toBeGreaterThan(0);
    for (const line of previews) {
      const args = line.split(/\s+/).slice(1);
      const home = harnessHome();
      const before = filesUnder(home);
      expect({ line, ...(await cli([...args, "--home", home])) }).toEqual({ line, code: 0, errors: [] });
      expect({ line, files: filesUnder(home) }).toEqual({ line, files: before });
      const state = await planState(args, home);
      expect({ line, kept: state.kept, skipped: state.skipped, hasWork: state.pending.length > 0 }).toEqual({ line, kept: [], skipped: [], hasWork: true });
    }
  });

  it("applies every shown setup command completely", async () => {
    const applies = setupLines().filter((line) => line.includes("--apply") && !line.includes("--uninstall"));
    expect(applies.length).toBeGreaterThan(0);
    for (const line of applies) {
      const args = line.split(/\s+/).slice(1);
      const home = harnessHome();
      expect({ line, ...(await cli([...args, "--home", home])) }).toEqual({ line, code: 0, errors: [] });
      expect({ line, ...(await planState(args, home)) }).toEqual({ line, pending: [], kept: [], skipped: [] });
    }
  });

  it("removes every component each shown uninstall command installed", async () => {
    const removals = setupLines().filter((line) => line.includes("--uninstall"));
    expect(removals.length).toBeGreaterThan(0);
    for (const line of removals) {
      const args = line.split(/\s+/).slice(1);
      const home = harnessHome();
      const fresh = await planState(args, home);
      const install = args.filter((arg) => arg !== "--uninstall");
      expect({ line, ...(await cli([...install, "--home", home])) }).toEqual({ line, code: 0, errors: [] });
      expect({ line, ...(await planState(args, home)) }).toEqual({ line, pending: [], kept: [], skipped: [] });
      expect({ line, ...(await cli([...args, "--home", home])) }).toEqual({ line, code: 0, errors: [] });
      // With --only, the shared skill stays while another installed harness still reads it; everything else must be gone.
      const expected = args.includes("--only") ? fresh.pending.filter((entry) => !entry.startsWith("skill ")) : fresh.pending;
      expect({ line, ...(await planState(args, home)) }).toEqual({ line, pending: expected, kept: [], skipped: [] });
    }
  });

  it("names only subcommands the CLI knows", async () => {
    const usage: string[] = [];
    await runCli([], { stdout: (text) => usage.push(text), stderr: (text) => usage.push(text) });
    const known = usage.join("\n");
    const subcommands = new Set(shownCommands().filter((line) => line.startsWith("osnova ")).map((line) => line.split(/\s+/)[1] ?? ""));
    for (const sub of subcommands) expect(known, sub).toContain(`osnova ${sub}`);
  });

  it("links the footer to the site's own document pages", () => {
    for (const href of ["/changelog/", "/privacy/", "/security/"]) expect(page).toContain(`href="${href}"`);
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

describe("marketing site document pages", () => {
  const pages = renderSitePages(root);

  it("renders the changelog, privacy and security pages", () => {
    expect(Object.keys(pages).sort()).toEqual(["changelog/index.html", "privacy/index.html", "security/index.html"]);
  });

  it("matches the committed pages, so a changed source document fails until the pages are rebuilt", () => {
    for (const [rel, html] of Object.entries(pages)) {
      const file = path.join(root, "site", "public", rel);
      expect(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "", `${rel} is stale; run pnpm site:pages`).toBe(html);
    }
  });

  it("keeps the source text, escapes code and points links at the site", () => {
    expect(pages["security/index.html"]).toContain('<a href="/privacy/">Privacy</a>');
    expect(pages["privacy/index.html"]).toContain('<a href="https://github.com/getdomovoi/osnova/issues">https://github.com/getdomovoi/osnova/issues</a>');
    expect(pages["changelog/index.html"]).toContain('<h2 id="v0-11-0">0.11.0 (2026-09-30)</h2>');
    expect(pages["changelog/index.html"]).toContain('<h3 id="v0-11-0-breaking">Breaking</h3>');
    expect(pages["changelog/index.html"]).toContain("<code>--instructions &lt;file&gt;</code>");
    expect(pages["changelog/index.html"]).toContain('href="#v0-11-0"');
  });
});

describe("marketing site crawl files", () => {
  const publicDir = path.join(root, "site", "public");
  const read = (name: string) => (fs.existsSync(path.join(publicDir, name)) ? fs.readFileSync(path.join(publicDir, name), "utf8") : "");

  it("lists every page in the sitemap, and nothing else", () => {
    const pages = fs.readdirSync(publicDir, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith("index.html"))
      .map((file) => path.dirname(file).split(path.sep).join("/"))
      .map((dir) => (dir === "." ? "https://getosnova.dev/" : `https://getosnova.dev/${dir}/`))
      .sort();
    const listed = [...read("sitemap.xml").matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]).sort();
    expect(listed).toEqual(pages);
  });

  it("points crawlers at the sitemap", () => {
    expect(read("robots.txt")).toContain("Sitemap: https://getosnova.dev/sitemap.xml");
  });
});

describe("marketing site theme", () => {
  const publicDir = path.join(root, "site", "public");
  const pages = fs.readdirSync(publicDir, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".html"));

  it("renders dark whatever the visitor's system theme", () => {
    expect(fs.readFileSync(path.join(publicDir, "styles.css"), "utf8")).not.toMatch(/prefers-color-scheme/);
    for (const file of pages) {
      const html = fs.readFileSync(path.join(publicDir, file), "utf8");
      expect(html, file).toContain('<meta name="color-scheme" content="dark">');
      expect(html, file).not.toMatch(/prefers-color-scheme: light/);
    }
  });
});
