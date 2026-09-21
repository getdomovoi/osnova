import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ask, buildIndex, applyChanges } from "../src/index.js";
import { formatAsk } from "../src/query/format.js";
import { OsnovaIndexImpl } from "../src/index/indexImpl.js";
import { queryContext } from "../src/query/context.js";

let temporary: string;
let workspace: string;
let cacheDir: string;

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-definition-ranking-"));
  workspace = path.join(temporary, "workspace");
  cacheDir = path.join(temporary, "cache");
  await fs.mkdir(workspace);
});

afterEach(async () => {
  await fs.rm(temporary, { recursive: true, force: true });
});

async function build(files: Record<string, string>) {
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await fs.writeFile(path.join(workspace, file), text);
  }
  return buildIndex(workspace, { cacheDir });
}

describe("definition-level retrieval", () => {
  it("retrieves the exact class rather than an earlier similarly named interface", async () => {
    const index = await build({ "types.ts": "export interface RetryOptions { attempts: number; }\nexport class RetryTimer { tick() { return 1; } }\n" });
    const hit = ask(index, "RetryTimer").hits[0];
    expect(hit?.symbol?.qualifiedName).toBe("types.ts#RetryTimer");
    expect(hit?.line).toBe(2);
    expect(hit?.excerpt).toContain("class RetryTimer");
  });

  it("lets multiple relevant definitions from one file participate", async () => {
    const index = await build({ "messages.ts": "export function parseMessage(payload: string) { return payload; }\nexport function sendMessage(payload: string) { return payload; }\n" });
    const names = ask(index, "parseMessage sendMessage", { limit: 2 }).hits.map((hit) => hit.symbol?.name);
    expect(new Set(names)).toEqual(new Set(["parseMessage", "sendMessage"]));
  });

  it("does not let repeated references outweigh an explicitly named definition", async () => {
    const index = await build({
      "reference.ts": "// parseMessage\n".repeat(500),
      "definition.ts": "export function parseMessage(value: string) { return value; }\n",
    });
    expect(ask(index, "parseMessage").hits[0]?.symbol?.qualifiedName).toBe("definition.ts#parseMessage");
  });

  it("uses identifier boundaries instead of substring exact matches", async () => {
    const index = await build({
      "a.ts": "export function serialize() { return 'deserialize'; }\n",
      "b.ts": "export function deserialize() { return 1; }\n",
    });
    expect(ask(index, "deserialize").hits[0]?.symbol?.qualifiedName).toBe("b.ts#deserialize");
  });

  it("supports short exact identifiers and snake/acronym name tokens", async () => {
    const index = await build({
      "a.ts": "export const x = 1;\nexport function parseHTTPHeaders() { return 1; }\n",
      "b.py": "def normalize_label(value):\n    return value\n",
    });
    expect(ask(index, "x").hits[0]?.symbol?.name).toBe("x");
    expect(ask(index, "HTTP headers").hits[0]?.symbol?.name).toBe("parseHTTPHeaders");
    expect(ask(index, "normalize label").hits[0]?.symbol?.name).toBe("normalize_label");
  });

  it("ranks adjacent documentation and returns its source-aligned excerpt", async () => {
    const text = "// Recover corrupted snapshot safely.\nexport function rebuild() { return 1; }\n";
    const index = await build({ "recovery.ts": text });
    const hit = ask(index, "recover corrupted snapshot").hits[0];
    expect(hit?.symbol?.name).toBe("rebuild");
    expect(hit?.excerpt).toContain("Recover corrupted snapshot");
    expect(hit?.excerpt).toBe(text.split("\n").slice((hit?.excerptStartLine ?? 1) - 1, (hit?.excerptStartLine ?? 1) - 1 + (hit?.excerpt.split("\n").length ?? 0)).join("\n"));
  });

  it("uses signature and body evidence without an exact name", async () => {
    const index = await build({
      "a.ts": "export function wait(signal: AbortSignal) { return signal; }\nexport function rotate() { return 'encryption keys'; }\n",
    });
    expect(ask(index, "AbortSignal").hits[0]?.symbol?.name).toBe("wait");
    expect(ask(index, "encryption keys").hits[0]?.symbol?.name).toBe("rotate");
  });

  it("keeps prose fallback and reports the actual searched-file count", async () => {
    const index = await build({ "notes.txt": "operational maintenance handbook\n", "src/a.ts": "export const unrelated = 1;\n" });
    const result = ask(index, "operational maintenance");
    expect(result.hits[0]?.file).toBe("notes.txt");
    expect(result.hits[0]?.symbol).toBeNull();
    expect(result.filesSearched).toBe(2);
    expect(ask(index, "absentword", { in: "src" }).filesSearched).toBe(1);
  });

  it("keeps filtering segment-aware and ranking independent of map insertion order", async () => {
    const index = await build({
      "src/a.ts": "export function target() {}\n", "src-other/b.ts": "export function target() {}\n",
    });
    const reversed = new OsnovaIndexImpl(index.root, new Map([...index.files].reverse()), index.edges);
    expect(ask(reversed, "target")).toEqual(ask(index, "target"));
    expect(ask(index, "target", { in: "src" }).hits.every((hit) => hit.file.startsWith("src/"))).toBe(true);
  });

  it("prefers qualified methods and avoids duplicate logical-symbol hits", async () => {
    const index = await build({ "reader.ts": "export class Reader {\n  decode() { return 1; }\n  get value() { return 1; }\n  set value(next: number) { this.decode(); }\n}\nexport class Other { decode() { return 2; } }\n" });
    expect(ask(index, "Reader.decode").hits[0]?.symbol?.qualifiedName).toBe("reader.ts#Reader.decode");
    const values = ask(index, "Reader.value next").hits.filter((hit) => hit.symbol?.qualifiedName === "reader.ts#Reader.value");
    expect(values).toHaveLength(1);
    expect(values[0]?.excerpt).toContain("set value");
  });

  it("uses Python docstrings as definition evidence", async () => {
    const index = await build({ "restore.py": "def rebuild():\n    \"\"\"Recover corrupted snapshots safely.\"\"\"\n    return 1\n" });
    const hit = ask(index, "recover corrupted snapshots").hits[0];
    expect(hit?.symbol?.name).toBe("rebuild");
    expect(hit?.excerpt).toContain("Recover corrupted snapshots");
  });

  it("recognizes docstrings after multiline Python signatures", async () => {
    const index = await build({ "emit.py": "def emit(\n    message: str,\n    newline: bool = True,\n):\n    \"\"\"Print a message plus newline to stdout.\"\"\"\n    return message\n" });
    const document = queryContext(index).documents.find((item) => item.symbol?.name === "emit");
    expect(document?.documentation.has("stdout")).toBe(true);
    expect(ask(index, "emit message newline stdout").hits[0]?.symbol?.name).toBe("emit");
  });

  it("keeps scores finite and ordered and respects zero limits", async () => {
    const index = await build({ "a.ts": "export function parse() {}\nexport function parser() { parse(); }\n" });
    const result = ask(index, "parse parser");
    expect(result.hits.every((hit) => Number.isFinite(hit.score))).toBe(true);
    expect(result.hits.map((hit) => hit.score)).toEqual(result.hits.map((hit) => hit.score).sort((a, b) => b - a));
    expect(ask(index, "parse", { limit: 0 })).toEqual({ hits: [], filesSearched: 1 });
  });

  it("does not reuse obsolete documents after an incremental update", async () => {
    const index = await build({ "a.ts": "export function cedar() {}\n" });
    expect(ask(index, "cedar").hits[0]?.symbol?.name).toBe("cedar");
    await fs.writeFile(path.join(workspace, "a.ts"), "export function quartz() {}\n");
    const updated = await applyChanges(index, workspace, ["a.ts"]);
    expect(ask(updated, "cedar").hits).toHaveLength(0);
    expect(ask(updated, "quartz").hits[0]?.symbol?.name).toBe("quartz");
  });

  it.each([-1, 0.5, NaN, Infinity])("rejects invalid result limits: %s", async (limit) => {
    const index = await build({ "a.ts": "export const value = 1;\n" });
    expect(() => ask(index, "value", { limit })).toThrow(RangeError);
  });
});

describe("role words and nested best matches", () => {
  const files = {
    "foo.py": "class Foo:\n    def bar(self):\n        return 1\n",
    "test_foo.py": "def test_flag_definition():\n    return 1\n",
  };

  it("does not let a role word like definition rank a stray test above the named method", async () => {
    const index = await build(files);
    const names = ask(index, "Foo.bar definition", { limit: 3 }).hits.map((hit) => hit.symbol?.qualifiedName);
    expect(names[0]).toBe("foo.py#Foo.bar");
    expect(names).not.toContain("test_foo.py#test_flag_definition");
  });

  it("still counts a role word when the query has nothing else", async () => {
    const index = await build(files);
    expect(ask(index, "definition").hits[0]?.symbol?.qualifiedName).toBe("test_foo.py#test_flag_definition");
  });

  it("prints the best-matching method as its own top hit instead of folding it under its class", async () => {
    const index = await build(files);
    const text = formatAsk(ask(index, "Foo.bar definition", { limit: 3 }));
    const headers = text.split("\n\n").map((block) => block.split("\n")[0]);
    expect(headers[0]).toBe("foo.py:2 method foo.py#Foo.bar");
    expect(text).not.toContain("also: .bar");
  });
});
