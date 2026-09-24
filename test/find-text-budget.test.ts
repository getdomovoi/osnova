import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { buildIndex } from "../src/index/build.js";
import { findTextDetailed } from "../src/query/findText.js";
import { matchInPath } from "../src/query/context.js";
import { createOsnovaMcpServer } from "../src/mcp/server.js";
import type { FindTextDetailedOptions, FindTextMatch, FindTextResult, OsnovaIndex } from "../src/types.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-repo");
const HOSTILE = "(a+)+b";

let temporary: string;
let workspace: string;
let cacheDir: string;
let hostileIndex: OsnovaIndex;
let sample: OsnovaIndex;

beforeAll(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-find-text-budget-"));
  workspace = path.join(temporary, "workspace");
  cacheDir = path.join(temporary, "cache");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "a.ts"), `// ${"a".repeat(60)}\nexport const x = 1;\n`);
  hostileIndex = await buildIndex(workspace);
  sample = await buildIndex(FIXTURE);
});

afterAll(async () => {
  await fs.rm(temporary, { recursive: true, force: true });
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function innermost(symbols: readonly { qualifiedName: string; span: { startLine: number; endLine: number } }[], line: number): string | null {
  let best: { q: string; size: number } | null = null;
  for (const symbol of symbols) {
    if (line < symbol.span.startLine || line > symbol.span.endLine) continue;
    const size = symbol.span.endLine - symbol.span.startLine;
    if (best === null || size < best.size) best = { q: symbol.qualifiedName, size };
  }
  return best !== null ? best.q : null;
}

function reference(index: OsnovaIndex, pattern: string, options: FindTextDetailedOptions = {}): FindTextResult {
  const regex = new RegExp(options.fixed === true ? escapeRegExp(pattern) : pattern, options.ignoreCase === true ? "gi" : "g");
  const matchLimit = options.matchesPerGroup ?? Infinity;
  let totalMatches = 0;
  const groups: { file: string; symbolQ: string | null; matches: FindTextMatch[] }[] = [];
  const byKey = new Map<string, (typeof groups)[number]>();
  const unsearchedFiles: string[] = [];
  for (const file of [...index.files.keys()].sort()) {
    if (!matchInPath([file], options.in ?? "")) continue;
    const card = index.files.get(file)!;
    if (card.diagnostics?.some((diagnostic) => diagnostic.code === "file-too-large") === true) unsearchedFiles.push(file);
    if (card.text.length === 0) continue;
    const lines = card.text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      regex.lastIndex = 0;
      let match = regex.exec(line);
      while (match !== null) {
        totalMatches += 1;
        const symbolQ = innermost(card.symbols, i + 1);
        const key = `${file}\u0000${symbolQ ?? "<module>"}`;
        let group = byKey.get(key);
        if (group === undefined) {
          group = { file, symbolQ, matches: [] };
          byKey.set(key, group);
          groups.push(group);
        }
        if (group.matches.length < matchLimit) {
          const last = group.matches[group.matches.length - 1];
          if (last === undefined || last.line !== i + 1 || last.col !== match.index) {
            group.matches.push({ line: i + 1, col: match.index, length: match[0].length, text: line });
          }
        }
        if (match[0].length === 0) regex.lastIndex += 1;
        match = regex.exec(line);
      }
    }
  }
  const ranked = groups.map((group) => ({ group, incoming: group.symbolQ === null ? 0 : index.incoming(group.symbolQ).length }));
  ranked.sort((a, b) => b.incoming - a.incoming || (a.group.file < b.group.file ? -1 : a.group.file > b.group.file ? 1 : 0) ||
    (a.group.symbolQ ?? "").localeCompare(b.group.symbolQ ?? ""));
  const selected = ranked.slice(0, options.limit ?? Infinity).map(({ group, incoming }) => ({
    file: group.file,
    symbol: group.symbolQ === null ? null : index.symbols.get(group.symbolQ) ?? null,
    incomingEdges: incoming,
    matches: group.matches,
  }));
  const omittedMatches = totalMatches - selected.reduce((count, group) => count + group.matches.length, 0);
  return {
    scope: "indexed-text", groups: selected, totalGroups: groups.length, totalMatches,
    omittedGroups: groups.length - selected.length, omittedMatches, truncated: omittedMatches > 0, unsearchedFiles,
  };
}

describe("findTextDetailed pattern budget", () => {
  it("refuses a catastrophically backtracking pattern inside its budget instead of hanging", () => {
    const started = performance.now();
    expect(() => findTextDetailed(hostileIndex, HOSTILE, { budgetMs: 300 })).toThrow(/pattern-budget-exceeded/);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("still answers a harmless pattern over the same text", () => {
    const result = findTextDetailed(hostileIndex, "aaaa", { budgetMs: 300 });
    expect(result.totalMatches).toBe(15);
  });

  it("rejects a budget that is not a positive safe integer", () => {
    for (const budgetMs of [0, -1, 1.5, Number.NaN]) {
      expect(() => findTextDetailed(sample, "retry", { budgetMs })).toThrow(/budget/);
    }
  });

  const cases: Array<[string, FindTextDetailedOptions]> = [
    ["retry", {}],
    ["retry", { ignoreCase: true, matchesPerGroup: 2, limit: 3 }],
    ["\\b(def|class|func|fn)\\b", {}],
    ["(?<=\\.)[a-z]", { matchesPerGroup: 1 }],
    ["^", { in: "src/util.ts" }],
    ["\\b", { in: "src/app.ts", matchesPerGroup: 4 }],
    ["x*", { in: "src", limit: 5 }],
    ["[A-Z]\\w+", { matchesPerGroup: 3 }],
    ["(\\w)\\1", {}],
    ["import .* from", {}],
    ["a{2}", {}],
    ["a{", { fixed: true }],
    ["(.", { fixed: true, ignoreCase: true }],
    ["", {}],
    ["zzzz-never-present", {}],
  ];

  it.each(cases)("returns the same result as the unbudgeted scan for %s %j", (pattern, options) => {
    expect(findTextDetailed(sample, pattern, options)).toEqual(reference(sample, pattern, options));
  });
});

describe("osnova_thread pattern budget over MCP", () => {
  it("returns a tool error for a hostile pattern and keeps serving later calls", async () => {
    const { server } = createOsnovaMcpServer(workspace, { cacheDir });
    const client = new Client({ name: "budget-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const hostile = await client.callTool({ name: "osnova_thread", arguments: { pattern: HOSTILE } });
      const text = ((hostile as { content?: ContentBlock[] }).content ?? []).map((block) => block.type === "text" ? block.text : "").join("\n");
      expect(hostile.isError).toBe(true);
      expect(text).toContain("pattern-budget-exceeded");
      const next = await client.callTool({ name: "osnova_outline", arguments: { file: "a.ts" } });
      expect(next.isError).toBeFalsy();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
