import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex, applyChanges, freshness, indexHealth, loadIndex, serializeArtifact } from "../src/index.js";
import { adapterFor } from "../src/extract/adapters.js";
import * as loader from "../src/grammar/loader.js";
import { runCli } from "../src/cli/cli.js";
import { renderMapCard } from "../src/query/mapCard.js";
import { workspaceDirFor } from "../src/cache/cache.js";
import { sha256Hex } from "../src/index/scan.js";
import { withSequentialExtract } from "./support/extract.js";

let temporary: string;
let workspace: string;
let cacheDir: string;

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-health-"));
  workspace = path.join(temporary, "workspace");
  cacheDir = path.join(temporary, "cache");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "one.ts"), "export function one() { return 1; }\n");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(temporary, { recursive: true, force: true });
});

describe("index health", () => {
  it("distinguishes fresh, stale and unavailable workspaces", async () => {
    const index = await buildIndex(workspace, { cacheDir });
    expect((await indexHealth(index)).state).toBe("fresh");
    await fs.appendFile(path.join(workspace, "one.ts"), "export const changed = 1;\n");
    expect((await indexHealth(index)).state).toBe("stale");
    await fs.rename(workspace, path.join(temporary, "moved"));
    expect((await indexHealth(index)).state).toBe("unavailable");
    await expect(freshness(index, workspace)).rejects.toThrow(/scan/);
  });

  it("never saves an apparently healthy empty index for a missing root", async () => {
    await expect(buildIndex(path.join(temporary, "missing"), { cacheDir })).rejects.toThrow(/scan/);
    await expect(fs.access(cacheDir)).rejects.toThrow();
  });

  it("treats unreadable ignore rules as a scan failure, not an empty ruleset", async () => {
    await fs.mkdir(path.join(workspace, ".gitignore"));
    await expect(buildIndex(workspace, { cacheDir })).rejects.toThrow(/ignore/);
  });

  it("does not interpret failed stat calls as deleted files", async () => {
    const index = await buildIndex(workspace, { cacheDir });
    vi.spyOn(fs, "stat").mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    await expect(applyChanges(index, workspace, ["one.ts"])).rejects.toThrow(/scan/);
    expect(index.symbols.has("one.ts#one")).toBe(true);
  });

  it("treats a file disappearing after scan as workspace drift", async () => {
    const index = await buildIndex(workspace, { cacheDir });
    vi.spyOn(fs, "readFile").mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "ENOENT" }));
    expect((await freshness(index, workspace)).deleted).toEqual(["one.ts"]);
  });

  it("retains text from syntax-recovered files with persistent partial diagnostics", async () => {
    await fs.writeFile(path.join(workspace, "broken.ts"), "export function broken( {");
    const index = await buildIndex(workspace, { cacheDir });
    expect(index.files.get("broken.ts")?.text).toContain("broken");
    expect(index.diagnostics).toContainEqual({ phase: "parse", path: "broken.ts", code: "syntax-errors" });
    expect((await indexHealth(index)).state).toBe("partial");
    const loaded = await loadIndex(workspace, { cacheDir });
    expect(loaded?.diagnostics).toEqual(index.diagnostics);
    expect(await renderMapCard(index, { staleCount: 0 })).toContain("osnova foundation: partial");
  });

  it("clears repaired diagnostics and preserves incremental/full equality", async () => {
    await fs.writeFile(path.join(workspace, "broken.ts"), "export function broken( {");
    const index = await buildIndex(workspace, { cacheDir });
    await fs.writeFile(path.join(workspace, "broken.ts"), "export function repaired() {}\n");
    const updated = await applyChanges(index, workspace, ["broken.ts"]);
    expect(updated.diagnostics).toEqual([]);
    expect(serializeArtifact(updated)).toEqual(serializeArtifact(await buildIndex(workspace, { cacheDir })));
  });

  it("reports extractor failures and releases the tree", () => withSequentialExtract(async () => {
    const parser = await loader.getParser("typescript");
    const tree = parser.parse("export function one() {}\n");
    if (tree === null) throw new Error("expected parsed tree");
    const dispose = vi.spyOn(tree, "delete");
    vi.spyOn(parser, "parse").mockReturnValueOnce(tree);
    vi.spyOn(adapterFor("typescript"), "extract").mockImplementationOnce(() => { throw new Error("fixture failure"); });
    const index = await buildIndex(workspace, { cacheDir });
    expect(dispose).toHaveBeenCalledOnce();
    expect(index.diagnostics).toContainEqual({ phase: "parse", path: "one.ts", code: "extraction-failed" });
    expect(index.files.get("one.ts")?.text).toContain("function one");
  }));

  it("does not disguise missing grammars as successful extraction", () => withSequentialExtract(async () => {
    vi.spyOn(loader, "getParser").mockRejectedValueOnce(new Error("grammar unavailable"));
    await expect(buildIndex(workspace, { cacheDir })).rejects.toThrow(/grammar-unavailable/);
  }));

  it.each([1, 2, 3, 4, 5, 6])("refuses to reuse outdated analysis format %s", async (version) => {
    const index = await buildIndex(workspace, { cacheDir });
    const artifact = JSON.parse(serializeArtifact(index).toString()) as { formatVersion: number };
    artifact.formatVersion = version;
    const raw = Buffer.from(JSON.stringify(artifact));
    await fs.writeFile(path.join(workspaceDirFor(cacheDir, workspace), "index.json"), raw);
    await fs.writeFile(path.join(workspaceDirFor(cacheDir, workspace), "index.sha"), `${sha256Hex(raw)}\n`);
    expect(await loadIndex(workspace, { cacheDir })).toBeUndefined();
  });

  it("CLI check fails for partial indexes and query output carries diagnostics", async () => {
    await fs.writeFile(path.join(workspace, "broken.ts"), "export function broken( {");
    await buildIndex(workspace, { cacheDir });
    const output: string[] = [];
    const io = { stdout: (text: string) => output.push(text), stderr: (text: string) => output.push(text) };
    expect(await runCli(["check", workspace, "--cache-dir", cacheDir], io)).toBe(1);
    expect(output.join("\n")).toContain("partial");
    output.length = 0;
    await runCli(["outline", "one.ts", "--workspace", workspace, "--cache-dir", cacheDir], io);
    expect(output.join("\n")).toContain("syntax-errors");
  });
});
