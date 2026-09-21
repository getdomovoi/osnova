import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyChanges, buildIndex, freshness, indexGeneration } from "../src/index.js";
import type { OsnovaIndex } from "../src/index.js";
import { parseJsonc } from "../src/index/tsconfig.js";

let temporary: string;
beforeEach(async () => { temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-alias-")); });
afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }); });

async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text);
  }
}

function outcome(index: OsnovaIndex, qualified: string): string[] {
  return index.outgoing(qualified).filter((edge) => edge.kind === "calls").sort((a, b) => a.line - b.line).map((edge) => {
    const r = edge.evidence?.source === "syntax" ? edge.evidence.resolution : undefined;
    if (r === undefined) return `${edge.toName}:unknown`;
    if (r.status === "resolved") return `${edge.toName}:${r.method}:${edge.toFile ?? ""}`;
    if (r.status === "ambiguous") return `${edge.toName}:ambiguous`;
    return `${edge.toName}:${r.reason}${r.external === undefined ? "" : ` external:${r.external}`}`;
  });
}

function importTargets(index: OsnovaIndex, fromFile: string): string[] {
  return index.edges.filter((edge) => edge.fromFile === fromFile && edge.kind === "imports").sort((a, b) => a.line - b.line).map((edge) => {
    const r = edge.evidence?.source === "syntax" ? edge.evidence.resolution : undefined;
    return `${edge.toName} -> ${r?.status === "resolved" ? edge.toFile ?? "" : r?.status === "unresolved" ? r.reason : "?"}`;
  });
}

describe("parseJsonc", () => {
  it("strips line and block comments outside strings and trailing commas", () => {
    expect(parseJsonc('{\n  // comment\n  "a": "x // not a comment", /* block */ "b": [1, 2,],\n}\n')).toEqual({ a: "x // not a comment", b: [1, 2] });
    expect(parseJsonc("{ not json")).toBeUndefined();
  });
});

describe("tsconfig path aliases", () => {
  it("resolves wildcard and exact paths entries from the nearest tsconfig, in declaration order of targets", async () => {
    const root = path.join(temporary, "ws");
    await write(root, {
      "tsconfig.json": '{\n  // root config\n  "compilerOptions": {\n    "paths": {\n      "@/*": ["./missing/*", "./src/*",],\n      "#util": ["./src/lib/util.ts"],\n    },\n  },\n}\n',
      "src/lib/util.ts": "export function helper(): number { return 1; }\nexport function other(): number { return 2; }\n",
      "src/lib/index.ts": "export function fromIndex(): number { return 3; }\n",
      "src/app/page.tsx": [
        "import { helper } from '@/lib/util';", "import { fromIndex } from '@/lib';", "import { other } from '#util';", "import { gone } from '@/nothing';",
        "export function Page() {", "  helper();", "  fromIndex();", "  other();", "  gone();", "}", "",
      ].join("\n"),
    });
    const index = await buildIndex(root, { cacheDir: path.join(temporary, "cache") });
    expect(outcome(index, "src/app/page.tsx#Page")).toEqual([
      "helper:import-binding:src/lib/util.ts",
      "fromIndex:import-binding:src/lib/index.ts",
      "other:import-binding:src/lib/util.ts",
      "gone:import-target-unresolved",
    ]);
    expect(importTargets(index, "src/app/page.tsx")).toEqual([
      "@/lib/util -> src/lib/util.ts", "@/lib -> src/lib/index.ts", "#util -> src/lib/util.ts", "@/nothing -> import-target-unresolved",
    ]);
  });

  it("resolves non-relative specifiers through baseUrl when no paths entry applies", async () => {
    const root = path.join(temporary, "base");
    await write(root, {
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "./src" } }),
      "src/lib/util.ts": "export function helper(): number { return 1; }\n",
      "src/app.ts": "import { helper } from 'lib/util';\nimport { nope } from 'lib/nope';\nexport function run() { helper(); nope(); }\n",
    });
    const index = await buildIndex(root, { cacheDir: path.join(temporary, "cache") });
    expect(outcome(index, "src/app.ts#run")).toEqual(["helper:import-binding:src/lib/util.ts", "nope:import-target-unresolved external:lib"]);
  });

  it("follows relative extends chains and resolves paths against an inherited baseUrl", async () => {
    const root = path.join(temporary, "ext");
    await write(root, {
      "tsconfig.base.json": JSON.stringify({ compilerOptions: { baseUrl: "./packages", paths: { "~/*": ["app/src/*"] } } }),
      "packages/app/tsconfig.json": JSON.stringify({ extends: "../../tsconfig.base.json", compilerOptions: { strict: true } }),
      "packages/app/src/util.ts": "export function helper(): number { return 1; }\n",
      "packages/app/src/main.ts": "import { helper } from '~/util';\nexport function run() { helper(); }\n",
      "packages/pkg/tsconfig.json": JSON.stringify({ extends: "@tsconfig/node20/tsconfig.json", compilerOptions: { strict: true } }),
      "packages/pkg/src/util.ts": "export function helper(): number { return 1; }\n",
      "packages/pkg/src/main.ts": "import { helper } from '~/util';\nexport function run() { helper(); }\n",
    });
    const index = await buildIndex(root, { cacheDir: path.join(temporary, "cache") });
    expect(outcome(index, "packages/app/src/main.ts#run")).toEqual(["helper:import-binding:packages/app/src/util.ts"]);
    expect(outcome(index, "packages/pkg/src/main.ts#run")).toEqual(["helper:import-target-unresolved"]);
  });

  it("keeps a specifier matched by two equally specific patterns unresolved with an explicit reason", async () => {
    const root = path.join(temporary, "amb");
    await write(root, {
      "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@x/*": ["./a/*"], "@x/*-util": ["./b/*"] } } }),
      "a/foo-util.ts": "export function helper(): number { return 1; }\n",
      "b/foo.ts": "export function helper(): number { return 2; }\n",
      "main.ts": "import { helper } from '@x/foo-util';\nexport function run() { helper(); }\n",
    });
    const index = await buildIndex(root, { cacheDir: path.join(temporary, "cache") });
    expect(outcome(index, "main.ts#run")).toEqual(["helper:import-target-ambiguous"]);
    expect(importTargets(index, "main.ts")).toEqual(["@x/foo-util -> import-target-ambiguous"]);
  });

  it("prefers the pattern with the longest literal prefix, as the compiler does", async () => {
    const root = path.join(temporary, "longest");
    await write(root, {
      "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./a/*"], "@/lib/*": ["./b/*"] } } }),
      "a/lib/x.ts": "export function helper(): number { return 1; }\n",
      "b/x.ts": "export function helper(): number { return 2; }\n",
      "main.ts": "import { helper } from '@/lib/x';\nexport function run() { helper(); }\n",
    });
    const index = await buildIndex(root, { cacheDir: path.join(temporary, "cache") });
    expect(outcome(index, "main.ts#run")).toEqual(["helper:import-binding:b/x.ts"]);
  });

  it("reads jsconfig.json for JavaScript files", async () => {
    const root = path.join(temporary, "js");
    await write(root, {
      "jsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }),
      "src/util.js": "export function helper() { return 1; }\n",
      "src/main.js": "import { helper } from '@/util';\nexport function run() { helper(); }\n",
    });
    const index = await buildIndex(root, { cacheDir: path.join(temporary, "cache") });
    expect(outcome(index, "src/main.js#run")).toEqual(["helper:import-binding:src/util.js"]);
  });

  it("re-resolves every edge when a tsconfig paths entry changes, equal to a full build", async () => {
    const root = path.join(temporary, "inc");
    await write(root, {
      "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./a/*"] } } }),
      "a/util.ts": "export function helper(): number { return 1; }\n",
      "b/util.ts": "export function helper(): number { return 2; }\n",
      "main.ts": "import { helper } from '@/util';\nexport function run() { helper(); }\n",
    });
    const first = await buildIndex(root, { cacheDir: path.join(temporary, "cache") });
    expect(outcome(first, "main.ts#run")).toEqual(["helper:import-binding:a/util.ts"]);
    await fs.writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@/*": ["./b/*"] } } }));
    const report = await freshness(first, root);
    expect(report.changed).toEqual(["tsconfig.json"]);
    const second = await applyChanges(first, root, report.changed);
    expect(outcome(second, "main.ts#run")).toEqual(["helper:import-binding:b/util.ts"]);
    const rebuilt = await buildIndex(root, { cacheDir: path.join(temporary, "cache2") });
    expect(indexGeneration(rebuilt)).toBe(indexGeneration(second));
    expect(indexGeneration(rebuilt)).not.toBe(indexGeneration(first));
  });
});
