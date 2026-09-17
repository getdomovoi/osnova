import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex, applyChanges, loadIndex, serializeArtifact } from "../src/index.js";
import { deserializeArtifact } from "../src/index/serialize.js";
import { callersDetailed } from "../src/query/callers.js";
import { formatCallersDetailed } from "../src/query/format.js";
import { resolveEdges } from "../src/index/resolve.js";
import type { FileCard, ReExport } from "../src/types.js";

let temporary: string;
let workspace: string;
let cacheDir: string;

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-reexports-"));
  workspace = path.join(temporary, "workspace");
  cacheDir = path.join(temporary, "cache");
  await fs.mkdir(workspace);
});
afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }); });

async function build(files: Record<string, string>) {
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await fs.writeFile(path.join(workspace, file), text);
  }
  return buildIndex(workspace, { cacheDir });
}

describe("re-export resolution", () => {
  it("follows a namespace re-export to the member definition", async () => {
    const index = await build({
      "core/util.ts": "export function partial() {}\nexport function other() {}\n",
      "core/index.ts": "export * as util from './util.js';\nexport const marker = 1;\n",
      "classic/schemas.ts": "import { util } from '../core/index.js';\nexport function caller() { util.partial(); }\n",
      "mini/schemas.ts": "import * as util from '../core/util.js';\nexport function caller() { util.partial(); }\n",
    });
    const classic = index.outgoing("classic/schemas.ts#caller")[0];
    expect(classic?.toSymbol).toBe("core/util.ts#partial");
    expect(classic?.evidence).toMatchObject({ resolution: { status: "resolved", method: "re-export-binding" } });
    expect((classic?.evidence as { resolution: { via?: unknown[] } }).resolution.via?.length).toBe(1);
    expect(index.outgoing("mini/schemas.ts#caller")[0]?.toSymbol).toBe("core/util.ts#partial");
    expect(index.incoming("core/util.ts#partial").map((edge) => edge.fromSymbol).sort()).toEqual(["classic/schemas.ts#caller", "mini/schemas.ts#caller"]);
    expect(index.files.get("core/index.ts")?.reExports).toEqual([{ kind: "namespace", exportedName: "util", source: "./util.js", line: 1 }]);
  });

  it("follows renamed barrels and records each source hop", async () => {
    const index = await build({
      "impl.ts": "export function work() {}\n",
      "middle.ts": "export { work as run } from './impl.js';\n",
      "front.ts": "export { run as submit } from './middle.js';\n",
      "client.ts": "import { submit as send } from './front.js';\nexport function caller() { send(); }\n",
    });
    const edge = index.outgoing("client.ts#caller")[0];
    expect(edge?.toName).toBe("send");
    expect(edge?.toSymbol).toBe("impl.ts#work");
    expect(edge?.evidence).toMatchObject({ source: "syntax", resolution: {
      status: "resolved", method: "re-export-binding", via: [
        { file: "front.ts", line: 1, exportedName: "submit", importedName: "run", targetFile: "middle.ts" },
        { file: "middle.ts", line: 1, exportedName: "run", importedName: "work", targetFile: "impl.ts" },
      ],
    } });
  });

  it("follows a local import exported under another name", async () => {
    const index = await build({
      "impl.ts": "export function work() {}\n",
      "front.ts": "import { work as local } from './impl.js';\nexport { local as run };\n",
      "client.ts": "import { run } from './front.js';\nexport function caller() { run(); }\n",
    });
    expect(index.outgoing("client.ts#caller")[0]?.toSymbol).toBe("impl.ts#work");
  });

  it("follows Python package exports through multiple modules", async () => {
    const index = await build({
      "pkg/impl.py": "def work():\n    return 1\n",
      "pkg/middle.py": "from .impl import work as local\n",
      "pkg/__init__.py": "from .middle import local as api\n__all__ = []\n",
      "client.py": "from pkg import api\n\ndef caller():\n    return api()\n",
    });
    expect(index.outgoing("client.py#caller")[0]?.toSymbol).toBe("pkg/impl.py#work");
  });

  it("normalizes package-relative imports at the indexed root", async () => {
    const index = await build({
      "impl.py": "def work():\n    return 1\n",
      "__init__.py": "from .impl import work as api\n",
      "client.py": "from . import api\n\ndef caller():\n    return api()\n",
    });
    expect(index.outgoing("client.py#caller")[0]?.toSymbol).toBe("impl.py#work");
  });

  it("does not follow relative imports beyond the indexed root", async () => {
    const index = await build({
      "impl.py": "def work():\n    return 1\n",
      "pkg/client.py": "from ...impl import work\n\ndef caller():\n    return work()\n",
    });
    expect(index.outgoing("pkg/client.py#caller")[0]?.toSymbol).toBeUndefined();
  });

  it("keeps conflicting wildcard exports ambiguous", async () => {
    const index = await build({
      "a.ts": "export function work() {}\n", "b.ts": "export function work() {}\n",
      "front.ts": "export * from './a.js';\nexport * from './b.js';\n",
      "client.ts": "import { work } from './front.js';\nexport function caller() { work(); }\n",
    });
    const edge = index.outgoing("client.ts#caller")[0];
    expect(edge?.toSymbol).toBeUndefined();
    expect(edge?.evidence).toMatchObject({ resolution: { status: "ambiguous", candidates: ["a.ts#work", "b.ts#work"] } });
  });

  it("deduplicates diamond paths to the same declaration", async () => {
    const index = await build({
      "impl.ts": "export function work() {}\n",
      "a.ts": "export * from './impl.js';\n", "b.ts": "export * from './impl.js';\n",
      "front.ts": "export * from './a.js';\nexport * from './b.js';\n",
      "client.ts": "import { work } from './front.js';\nexport function caller() { work(); }\n",
    });
    expect(index.outgoing("client.ts#caller")[0]?.toSymbol).toBe("impl.ts#work");
  });

  it("lets explicit exports override wildcard paths", async () => {
    const index = await build({
      "impl.ts": "export function work() {}\n",
      "front.ts": "export * from 'unknown';\nexport { work } from './impl.js';\n",
      "client.ts": "import { work } from './front.js';\nexport function caller() { work(); }\n",
    });
    expect(index.outgoing("client.ts#caller")[0]?.toSymbol).toBe("impl.ts#work");
  });

  it("does not silently ignore an unknown competing wildcard", async () => {
    const index = await build({
      "impl.ts": "export function work() {}\n",
      "front.ts": "export * from './impl.js';\nexport * from 'unknown';\n",
      "client.ts": "import { work } from './front.js';\nexport function caller() { work(); }\n",
    });
    expect(index.outgoing("client.ts#caller")[0]?.evidence).toMatchObject({ resolution: { status: "unresolved", reason: "re-export-incomplete" } });
  });

  it("terminates pure cycles and finds valid exits from wildcard cycles", async () => {
    const index = await build({
      "impl.ts": "export function work() {}\n",
      "a.ts": "export * from './b.js';\n", "b.ts": "export * from './a.js';\nexport * from './impl.js';\n",
      "x.ts": "export * from './y.js';\n", "y.ts": "export * from './x.js';\n",
      "client.ts": "import { work } from './a.js';\nimport { absent } from './x.js';\nexport function caller() { work(); absent(); }\n",
    });
    const edges = index.outgoing("client.ts#caller");
    expect(edges.find((edge) => edge.toName === "work")?.toSymbol).toBe("impl.ts#work");
    expect(edges.find((edge) => edge.toName === "absent")?.evidence).toMatchObject({ resolution: { status: "unresolved", reason: "re-export-cycle" } });
  });

  it("does not forward defaults through stars or type-only re-exports", async () => {
    const index = await build({
      "impl.ts": "export default class Named {}\nexport class TypeOnly {}\n",
      "front.ts": "export * from './impl.js';\nexport type { TypeOnly } from './impl.js';\n",
      "client.ts": "import Default from './front.js';\nexport function caller() { return new Default(); }\n",
    });
    expect(index.outgoing("client.ts#caller")[0]?.toSymbol).toBeUndefined();
  });

  it("blocks an exported import after rebinding", async () => {
    const index = await build({
      "pkg/impl.py": "def work():\n    return 1\n",
      "pkg/__init__.py": "from .impl import work as api\napi = 0\n",
      "client.py": "from pkg import api\n\ndef caller():\n    return api()\n",
    });
    expect(index.outgoing("client.py#caller")[0]?.toSymbol).toBeUndefined();
    expect(index.outgoing("client.py#caller")[0]?.evidence).toMatchObject({ resolution: { reason: "re-export-incomplete" } });
  });

  it("persists links and re-resolves unchanged clients when a barrel changes", async () => {
    const index = await build({
      "a.ts": "export function work() {}\n", "b.ts": "export function work() {}\n",
      "front.ts": "export { work } from './a.js';\n",
      "client.ts": "import { work } from './front.js';\nexport function caller() { work(); }\n",
    });
    expect(index.outgoing("client.ts#caller")[0]?.toSymbol).toBe("a.ts#work");
    const loaded = await loadIndex(workspace, { cacheDir });
    expect(loaded?.files.get("front.ts")?.reExports).toEqual(index.files.get("front.ts")?.reExports);
    await fs.writeFile(path.join(workspace, "front.ts"), "export { work } from './b.js';\n");
    const updated = await applyChanges(loaded ?? index, workspace, ["front.ts"]);
    expect(updated.outgoing("client.ts#caller")[0]?.toSymbol).toBe("b.ts#work");
    expect(serializeArtifact(updated)).toEqual(serializeArtifact(await buildIndex(workspace, { cacheDir })));
  });

  it("forwards an explicit default and a default import exported locally", async () => {
    const index = await build({
      "impl.ts": "export default class Named {}\n",
      "middle.ts": "export { default as Client } from './impl.js';\n",
      "front.ts": "import { Client as Local } from './middle.js';\nexport default Local;\n",
      "client.ts": "import Client from './front.js';\nexport function caller() { return new Client(); }\n",
    });
    expect(index.outgoing("client.ts#caller")[0]?.toSymbol).toBe("impl.ts#Named");
    const text = formatCallersDetailed(callersDetailed(index, "client.ts#caller", { direction: "out" }));
    expect(text).toContain("via front.ts:2");
    expect(text).toContain("impl.ts (export default)");
  });

  it("does not treat a type-only forwarding clause as a runtime export", async () => {
    const index = await build({
      "impl.ts": "export class Client {}\n",
      "front.ts": "export type { Client } from './impl.js';\n",
      "client.ts": "import { Client } from './front.js';\nexport function caller() { return new Client(); }\n",
    });
    expect(index.outgoing("client.ts#caller")[0]?.toSymbol).toBeUndefined();
  });

  it("does not fall back to stars after an explicit missing export", async () => {
    const index = await build({
      "impl.ts": "export function work() {}\n",
      "front.ts": "export { missing as work } from './impl.js';\nexport * from './impl.js';\n",
      "client.ts": "import { work } from './front.js';\nexport function caller() { work(); }\n",
    });
    expect(index.outgoing("client.ts#caller")[0]?.toSymbol).toBeUndefined();
  });

  it("tracks cycles by module and export name rather than module alone", async () => {
    const index = await build({
      "a.ts": "export { bridge as api } from './b.js';\nexport function terminal() {}\n",
      "b.ts": "export { terminal as bridge } from './a.js';\n",
      "client.ts": "import { api } from './a.js';\nexport function caller() { api(); }\n",
    });
    expect(index.outgoing("client.ts#caller")[0]?.toSymbol).toBe("a.ts#terminal");
  });

  it("reports an incomplete result instead of overflowing on very deep chains", async () => {
    const files: Record<string, string> = { "leaf.ts": "export function work() {}\n", "client.ts": "import { work } from './hop0.js';\nexport function caller() { work(); }\n" };
    for (let i = 0; i < 130; i += 1) files[`hop${i}.ts`] = `export * from './${i === 129 ? "leaf" : `hop${i + 1}`}.js';\n`;
    const index = await build(files);
    expect(index.outgoing("client.ts#caller")[0]?.evidence).toMatchObject({ resolution: { status: "unresolved", reason: "re-export-incomplete" } });
  });

  it("uses package initializers before a same-name Python module file", async () => {
    const index = await build({
      "thing.py": "def work():\n    return 1\n", "thing/__init__.py": "def work():\n    return 2\n",
      "client.py": "from thing import work\n\ndef caller():\n    return work()\n",
    });
    expect(index.outgoing("client.py#caller")[0]?.toSymbol).toBe("thing/__init__.py#work");
  });

  it("rejects malformed persisted export metadata", async () => {
    const index = await build({ "front.ts": "export * from './missing.js';\n" });
    const artifact = JSON.parse(serializeArtifact(index).toString()) as { files: Array<{ reExports: unknown }> };
    const file = artifact.files[0];
    if (file === undefined) throw new Error("missing fixture");
    file.reExports = [{ kind: "star", source: 42, line: 1 }];
    expect(() => deserializeArtifact(JSON.stringify(artifact), undefined)).toThrow(/corrupt re-export/);
  });

  it("bounds wide export searches without pretending the unvisited paths are empty", () => {
    const make = (file: string, links: readonly ReExport[] = []): FileCard => ({
      path: file, language: "typescript", hash: "fixture", size: 0, lineCount: 0, text: "", symbols: [], reExports: links,
    });
    const files = new Map<string, FileCard>([["client.ts", make("client.ts")]]);
    const links: ReExport[] = [];
    for (let i = 0; i < 4100; i += 1) {
      const file = `part${i}.ts`;
      files.set(file, make(file));
      links.push({ kind: "star", source: `./part${i}.js`, line: i + 1 });
    }
    files.set("front.ts", make("front.ts", links));
    const edges = resolveEdges({ root: "/fixture", files, rawEdges: new Map([["client.ts", [{
      kind: "calls", toName: "work", enclosing: "caller", line: 1,
      binding: { kind: "import", source: "./front.js", importedName: "work" },
    }]]]) });
    expect(edges[0]?.evidence).toMatchObject({ resolution: { status: "unresolved", reason: "re-export-incomplete" } });
  });
});
