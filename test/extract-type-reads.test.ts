import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { Node } from "web-tree-sitter";
import { extractCard } from "../src/index/build.js";
import { getParser } from "../src/grammar/loader.js";
import { languageForPath } from "../src/grammar/languages.js";
import fs from "node:fs/promises";

// `Node.type` is a getter that crosses into WASM on every read, so re-reading it inside one visitor
// body cost a sixth of a build. Each walk of a tree reads a node's type about once; the bound keeps
// a visitor from drifting back to one read per comparison.
const FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-repo");
const FILES = ["src/app.ts", "src/util.ts", "src/server.py", "src/pyclient.py", "src/main.go", "src/extra.go", "src/lib.rs", "src/more.rs", "src/App.java", "src/Program.cs", "src/Extra.cs"];
const MAX_READS_PER_NODE = 6;

const descriptor = Object.getOwnPropertyDescriptor(Node.prototype, "type")!;
let reads = 0;

beforeAll(() => {
  Object.defineProperty(Node.prototype, "type", {
    configurable: true,
    get(this: Node) { reads += 1; return descriptor.get!.call(this) as string; },
  });
});

afterAll(() => {
  Object.defineProperty(Node.prototype, "type", descriptor);
});

describe("extraction reads each node type a bounded number of times", () => {
  it.each(FILES)("%s", async (relPath) => {
    const language = languageForPath(relPath);
    if (language === undefined) throw new Error(`no grammar for ${relPath}`);
    const parser = await getParser(language);
    const tree = parser.parse(await fs.readFile(path.join(FIXTURE, relPath), "utf8"));
    const nodes = tree?.rootNode.descendantCount ?? 0;
    tree?.delete();
    reads = 0;
    await extractCard(FIXTURE, relPath);
    expect(nodes).toBeGreaterThan(0);
    expect(reads / nodes).toBeLessThanOrEqual(MAX_READS_PER_NODE);
  });
});
