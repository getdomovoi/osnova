import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { previewSetup } from "../src/diagnostics/setup-preview.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "osnova-preview-"));
  roots.push(root);
  return root;
}
const options = { cliPath: path.resolve("dist/bin.js") };

it("returns full marked configuration and command arguments without writing or launching", async () => {
  const root = await fixture();
  const preview = await previewSetup(root, options);
  expect(preview.mode).toBe("preview");
  expect(preview.canApply).toBe(true);
  expect(preview.changes[0]?.action).toBe("create");
  const config = JSON.parse(preview.changes[0]!.content);
  expect(config._osnova.owner).toBe("osnova/setup");
  expect(config.mcpServers.osnova.args).toEqual([options.cliPath, "mcp", "--workspace", root]);
  expect(await readdir(root)).toEqual([]);
});

it("recognizes owned unchanged files and previews replacements with a baseline hash", async () => {
  const root = await fixture();
  const initial = await previewSetup(root, options);
  const change = initial.changes[0]!;
  await mkdir(path.dirname(change.path));
  await writeFile(change.path, change.content);
  expect((await previewSetup(root, options)).changes[0]?.action).toBe("unchanged");
  const updated = await previewSetup(root, { cliPath: path.resolve("other/bin.js") });
  expect(updated.changes[0]?.action).toBe("replace");
  expect(updated.changes[0]?.beforeHash).toMatch(/^[a-f0-9]{64}$/);
  expect(await readFile(change.path, "utf8")).toBe(change.content);
});

it("reports unowned, malformed and oversized files without leaking existing contents", async () => {
  const root = await fixture();
  await mkdir(path.join(root, ".osnova"));
  for (const content of ["FAKE_SECRET=do-not-print", "{}", "x".repeat(70_000), JSON.stringify({
    _osnova: { owner: "osnova/setup", version: 1 }, mcpServers: { osnova: { command: "node", args: ["bin.js", "mcp", "--workspace", root], env: { FAKE_SECRET: "do-not-print" } } },
  })]) {
    await writeFile(path.join(root, ".osnova/mcp.json"), content);
    const preview = await previewSetup(root, options);
    expect(preview.canApply).toBe(false);
    expect(preview.changes[0]?.action).toBe("conflict");
    expect(JSON.stringify(preview)).not.toContain("do-not-print");
    expect(await readFile(path.join(root, ".osnova/mcp.json"), "utf8")).toBe(content);
  }
});

it("refuses symlinked destinations and missing workspaces", async () => {
  const root = await fixture();
  const elsewhere = await fixture();
  await symlink(elsewhere, path.join(root, ".osnova"), "junction");
  expect((await previewSetup(root, options)).canApply).toBe(false);
  expect(await readdir(elsewhere)).toEqual([]);
  expect((await previewSetup(path.join(root, "missing"), options)).canApply).toBe(false);
});
