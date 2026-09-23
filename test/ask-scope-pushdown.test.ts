import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index/build.js";
import { askDetailed } from "../src/query/ask.js";
import { countTokens, fileDocumentsCached, queryContext, resetQueryCaches, tokenize } from "../src/query/context.js";
import type { OsnovaIndex } from "../src/types.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-repo");

const files: Record<string, string> = {
  "api/server.ts": [
    'import express from "express";',
    "// Hands résumé text to the ResumeParser from lib.",
    "/** Lists every user the café registry holds. */",
    "export function listUsers(req: unknown, res: unknown): void { console.log(req, res); }",
    "const app = express();",
    'app.get("/users", listUsers);',
    'app.post("/users/:id", listUsers);',
    "",
  ].join("\n"),
  "api/cats.controller.ts": [
    'import { Controller, Get, Post } from "@nestjs/common";',
    '@Controller("cats")',
    "export class CatsController {",
    "  // Returns the whole registry of cats.",
    "  @Get()",
    '  findAll(): string { return "registry"; }',
    '  @Post(":id")',
    '  create(): string { return "created"; }',
    "}",
    "",
  ].join("\n"),
  "lib/registry.py": [
    "class Registry:",
    '    """A registry of users, keyed by their identifier."""',
    "",
    "    def lookup(self, identifier):",
    '        """Look up one user in the registry."""',
    "        return self.users.get(identifier)",
    "",
    "# The express app calls this registry through its routes.",
    "def parse_registry(text):",
    "    # Parse the serialized registry, then validate it.",
    "    return Registry()",
    "",
  ].join("\n"),
  "lib/nested/deep.ts": [
    "// Ärger with the naïve résumé parser: parseRésumé splits on camel humps.",
    "export class ResumeParser {",
    "  parse(text: string): string[] { return text.split(/\\s+/); }",
    "  parseHTTPResponse(): void {}",
    "}",
    "export const users = new Map<string, ResumeParser>();",
    "",
  ].join("\n"),
  "notes.md": "# Registry notes\n\nThe user registry is parsed at startup.\n",
};

let temporary: string;
let mixed: OsnovaIndex;
let sample: OsnovaIndex;

beforeAll(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-ask-scope-"));
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(temporary, file)), { recursive: true });
    await fs.writeFile(path.join(temporary, file), text);
  }
  mixed = await buildIndex(temporary);
  sample = await buildIndex(FIXTURE);
});

afterAll(async () => {
  await fs.rm(temporary, { recursive: true, force: true });
});

function view(index: OsnovaIndex): OsnovaIndex {
  return {
    root: index.root,
    files: index.files,
    symbols: index.symbols,
    get edges() { return index.edges; },
    incoming: (name) => index.incoming(name),
    outgoing: (name) => index.outgoing(name),
    edgesForFile: (file) => index.edgesForFile(file),
  };
}

function wholeCorpus(index: OsnovaIndex, question: string, scope: string, limit: number): ReturnType<typeof askDetailed> {
  resetQueryCaches();
  const fresh = view(index);
  queryContext(fresh);
  return askDetailed(fresh, question, { in: scope, limit });
}

describe("ask with a path scope", () => {
  it("builds search documents only for files inside the scope", () => {
    resetQueryCaches();
    const index = view(sample);
    const result = askDetailed(index, "retry timer", { in: "src/util.ts" });
    expect(result.filesSearched).toBe(1);
    const outside = [...index.files.keys()].filter((file) => file !== "src/util.ts");
    expect(outside.length).toBeGreaterThan(5);
    expect(outside.filter((file) => fileDocumentsCached(index, file))).toEqual([]);
    expect(fileDocumentsCached(index, "src/util.ts")).toBe(true);
  });

  const questions = [
    "retry timer", "pad string width", "GET /users", "POST /cats/:id", "registry users", "parse registry",
    "look up one user", "café résumé", "ResumeParser parse", "parseHTTPResponse", "the of and", "absentword",
    "users", "Registry lookup identifier", "cats controller find all", "notes startup", "ResumeParser", "express app",
  ];
  const scopes = ["api", "api/", "lib", "lib/nested/deep.ts", "lib/registry.py", "notes.md", "src", "src/util.ts", "missing"];

  it("scores exactly as the whole-corpus context does, with repository-wide statistics", () => {
    for (const index of [mixed, sample]) {
      for (const question of questions) {
        for (const scope of scopes) {
          const expected = wholeCorpus(index, question, scope, 50);
          resetQueryCaches();
          const actual = askDetailed(view(index), question, { in: scope, limit: 50 });
          expect(actual, `${question} in ${scope}`).toEqual(expected);
        }
      }
    }
  });

  it("scores exactly when some files outside the scope are already cached", () => {
    for (const index of [mixed, sample]) {
      for (const question of questions) {
        const expected = wholeCorpus(index, question, "lib", 50);
        resetQueryCaches();
        askDetailed(view(index), question, { in: "api" });
        askDetailed(view(index), question, { in: "src/app.ts" });
        const actual = askDetailed(view(index), question, { in: "lib", limit: 50 });
        expect(actual, question).toEqual(expected);
      }
    }
  });
});

describe("countTokens", () => {
  it("counts the tokens tokenize returns for every line of a text", () => {
    const alphabet = ["a", "Z", "b", "Q", "9", "_", " ", ".", "\n", "é", "İ", "中", "😀", "the", "of", "IS"];
    let state = 7;
    for (let sample = 0; sample < 3000; sample += 1) {
      let text = "";
      for (let i = 0; i < 1 + (sample % 60); i += 1) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        text += alphabet[state % alphabet.length];
      }
      const expected = text.split("\n").reduce((count, line) => count + tokenize(line).length, 0);
      expect(countTokens(text), JSON.stringify(text)).toBe(expected);
    }
  });
});
