import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index.js";
import type { OsnovaEdge } from "../src/index.js";
import { parseCargoLock, parseGoMod, parseGoSum, parsePackageLock, parsePipfileLock, parsePnpmLock, parsePoetryLock, parseRequirements, parseUvLock, parseYarnLock } from "../src/index/external.js";
import { resolutionCoverage } from "../src/query/coverage.js";
import { formatCoverage, formatCallersDetailed } from "../src/query/format.js";
import { callersDetailed } from "../src/query/callers.js";

let temporary: string;
beforeEach(async () => { temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-external-")); });
afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }); });

const entries = (map: ReadonlyMap<string, string>): Array<[string, string]> => [...map].sort();

describe("lockfile parsers", () => {
  it("reads pnpm importers and unique package versions, skipping links and peer suffixes", () => {
    const lock = parsePnpmLock([
      "lockfileVersion: '9.0'", "", "importers:", "", "  .:", "    devDependencies:", "      vitest:", "        specifier: ^4.1.5",
      "        version: 4.1.5(@types/node@22.13.13)(vite@7.3.6(jiti@2.7.0))", "      zod3:", "        specifier: npm:zod@~3.24.0", "        version: zod@3.24.3",
      "      zod:", "        specifier: workspace:*", "        version: link:packages/zod",
      "  packages/docs:", "    dependencies:", "      '@sinclair/typebox':", "        specifier: ^0.34.0", "        version: 0.34.33",
      "", "packages:", "", "  '@sinclair/typebox@0.34.33':", "    resolution: {integrity: x}", "  vitest@4.1.5:", "    resolution: {integrity: y}",
      "  zod@3.24.3:", "  zod@4.0.8:", "  '@types/node@22.13.13':", "", "snapshots:", "", "  vitest@4.1.5(jiti@2.7.0):", "",
    ].join("\n"));
    expect(entries(lock.importers.get(".")!)).toEqual([["vitest", "4.1.5"], ["zod3", "3.24.3"]]);
    expect(entries(lock.importers.get("packages/docs")!)).toEqual([["@sinclair/typebox", "0.34.33"]]);
    expect(entries(lock.packages)).toEqual([["@sinclair/typebox", "0.34.33"], ["@types/node", "22.13.13"], ["vitest", "4.1.5"]]);
  });

  it("reads package-lock top-level node_modules entries (v2/v3) and v1 dependencies", () => {
    const v3 = parsePackageLock(JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "app" }, "node_modules/lodash": { version: "4.17.21" }, "node_modules/@scope/pkg": { version: "1.2.3" }, "node_modules/a/node_modules/lodash": { version: "3.0.0" }, "packages/lib": { version: "0.0.1" } } }));
    expect(entries(v3)).toEqual([["@scope/pkg", "1.2.3"], ["lodash", "4.17.21"]]);
    const v1 = parsePackageLock(JSON.stringify({ lockfileVersion: 1, dependencies: { lodash: { version: "4.17.21", dependencies: { x: { version: "9" } } } } }));
    expect(entries(v1)).toEqual([["lodash", "4.17.21"]]);
    expect(entries(parsePackageLock("{not json"))).toEqual([]);
  });

  it("reads classic and berry yarn lockfiles and drops packages with competing versions", () => {
    const classic = parseYarnLock(['# yarn lockfile v1', '', '"@scope/pkg@^1.0.0", "@scope/pkg@^1.2.0":', '  version "1.2.3"', '', 'lodash@^4.0.0:', '  version "4.17.21"', '', 'lodash@^3.0.0:', '  version "3.10.1"', ''].join("\n"));
    expect(entries(classic)).toEqual([["@scope/pkg", "1.2.3"]]);
    const berry = parseYarnLock(['__metadata:', '  version: 8', '', '"lodash@npm:^4.0.0":', '  version: 4.17.21', '  resolution: "lodash@npm:4.17.21"', '', '"@scope/pkg@npm:^1.0.0, @scope/pkg@npm:^1.2.0":', '  version: 1.2.3', ''].join("\n"));
    expect(entries(berry)).toEqual([["@scope/pkg", "1.2.3"], ["lodash", "4.17.21"]]);
  });

  it("reads poetry, uv, Pipfile and pinned requirements with normalized names", () => {
    const toml = ['[[package]]', 'name = "Typing_Extensions"', 'version = "4.12.2"', '', '[[package]]', 'name = "click"', 'version = "8.1.7"', 'source = { editable = "." }', ''].join("\n");
    expect(entries(parsePoetryLock(toml))).toEqual([["click", "8.1.7"], ["typing-extensions", "4.12.2"]]);
    expect(entries(parseUvLock(toml))).toEqual([["click", "8.1.7"], ["typing-extensions", "4.12.2"]]);
    expect(entries(parsePipfileLock(JSON.stringify({ default: { requests: { version: "==2.32.3" } }, develop: { pytest: { version: "==8.3.2" }, editable_thing: { editable: true } } })))).toEqual([["pytest", "8.3.2"], ["requests", "2.32.3"]]);
    expect(entries(parseRequirements(["# pinned", "requests==2.32.3 ; python_version >= '3.8'", "PyYAML == 6.0.2", "flask>=2.0", "-e .", "numpy==1.26.4 \\", "    --hash=sha256:abc", ""].join("\n")))).toEqual([["numpy", "1.26.4"], ["pyyaml", "6.0.2"], ["requests", "2.32.3"]]);
  });

  it("reads go.mod require blocks, go.sum lines and Cargo.lock packages", () => {
    expect(entries(parseGoMod(["module example.com/app", "", "go 1.22", "", "require (", "\tgithub.com/spf13/cobra v1.8.0", "\tgolang.org/x/sys v0.20.0 // indirect", ")", "", "require github.com/pkg/errors v0.9.1", ""].join("\n")))).toEqual([["github.com/pkg/errors", "v0.9.1"], ["github.com/spf13/cobra", "v1.8.0"], ["golang.org/x/sys", "v0.20.0"]]);
    expect(entries(parseGoSum(["github.com/spf13/cobra v1.8.0 h1:abc=", "github.com/spf13/cobra v1.8.0/go.mod h1:def=", "golang.org/x/sys v0.19.0/go.mod h1:x=", "golang.org/x/sys v0.20.0 h1:y=", ""].join("\n")))).toEqual([["github.com/spf13/cobra", "v1.8.0"], ["golang.org/x/sys", "v0.20.0"]]);
    expect(entries(parseCargoLock(['version = 4', '', '[[package]]', 'name = "serde"', 'version = "1.0.210"', 'source = "registry+https://github.com/rust-lang/crates.io-index"', '', '[[package]]', 'name = "syn"', 'version = "1.0.109"', '', '[[package]]', 'name = "syn"', 'version = "2.0.77"', ''].join("\n")))).toEqual([["serde", "1.0.210"]]);
  });
});

describe("external import labels", () => {
  it("labels unresolved bare specifiers with the package and lockfile version and leaves in-repo imports generic", async () => {
    const root = path.join(temporary, "ws"); await fs.mkdir(path.join(root, "packages/lib/src"), { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "root", private: true }));
    await fs.writeFile(path.join(root, "pnpm-lock.yaml"), ["lockfileVersion: '9.0'", "", "importers:", "", "  .:", "    devDependencies:", "      vitest:", "        specifier: ^4.1.5", "        version: 4.1.5(jiti@2.7.0)",
      "  packages/lib:", "    dependencies:", "      lodash:", "        specifier: ^4.0.0", "        version: 4.17.21", "      '@scope/pkg':", "        specifier: ^1.0.0", "        version: 1.2.3",
      "", "packages:", "", "  vitest@4.1.5:", "  lodash@4.17.21:", "  '@scope/pkg@1.2.3':", "  chalk@5.3.0:", ""].join("\n"));
    await fs.writeFile(path.join(root, "packages/lib/package.json"), JSON.stringify({ name: "@ws/lib", main: "src/index.ts" }));
    await fs.writeFile(path.join(root, "packages/lib/src/index.ts"), [
      "import { test } from 'vitest';", "import fp from 'lodash/fp';", "import { thing } from '@scope/pkg';", "import chalk from 'chalk';", "import { readFile } from 'node:fs';", "import { alias } from '@/loaders/source';", "import { missing } from '@ws/lib/missing';", "import { local } from './nope.js';", "import { untracked } from 'untracked-pkg';",
      "export function use() {", "  test();", "  fp();", "  thing();", "  chalk();", "  readFile();", "  alias();", "  missing();", "  local();", "  untracked();", "}", "",
    ].join("\n"));
    const index = await buildIndex(root, { cacheDir: path.join(temporary, "cache") });
    const labels = index.outgoing("packages/lib/src/index.ts#use").filter((edge) => edge.kind === "calls").sort((a, b) => a.line - b.line)
      .map((edge) => { const r = edge.evidence?.source === "syntax" ? edge.evidence.resolution : undefined; return `${edge.toName}:${r?.status === "unresolved" ? `${r.reason}${r.external === undefined ? "" : ` external:${r.external}`}` : r?.status}`; });
    expect(labels).toEqual([
      "test:import-target-unresolved external:vitest@4.1.5",
      "fp:import-target-unresolved external:lodash@4.17.21",
      "thing:import-target-unresolved external:@scope/pkg@1.2.3",
      "chalk:import-target-unresolved external:chalk@5.3.0",
      "readFile:import-target-unresolved external:node:fs",
      "alias:import-target-unresolved",
      "missing:import-target-unresolved",
      "local:import-target-unresolved",
      "untracked:import-target-unresolved external:untracked-pkg",
    ]);
    const imports = index.edges.filter((edge) => edge.fromFile === "packages/lib/src/index.ts" && edge.kind === "imports" && edge.toName === "vitest");
    expect(imports[0]?.evidence).toEqual({ source: "syntax", resolution: { status: "unresolved", reason: "import-target-unresolved", external: "vitest@4.1.5" } });
    const report = resolutionCoverage(index);
    expect(report.total).toMatchObject({ unresolvedImportCalls: 9, externalImportCalls: 6 });
    expect(report.total.byExternal).toEqual({ "@scope/pkg@1.2.3": 1, "chalk@5.3.0": 1, "lodash@4.17.21": 1, "node:fs": 1, "untracked-pkg": 1, "vitest@4.1.5": 1 });
    const text = formatCoverage(report);
    expect(text).toContain("- import-target-unresolved: 9 (external 6, in-repo 3)");
    expect(text).toContain("external packages (top 10):\n- @scope/pkg@1.2.3: 1\n- chalk@5.3.0: 1");
    const callers = formatCallersDetailed(callersDetailed(index, "packages/lib/src/index.ts#use", { direction: "out" }));
    expect(callers).toMatch(/^d1 calls test packages\/lib\/src\/index\.ts:\d+ \[import-target-unresolved \(external:vitest@4\.1\.5\)\]$/m);
  });

  it("labels Python absolute imports outside the workspace and keeps relative and in-repo imports generic", async () => {
    const root = path.join(temporary, "py"); await fs.mkdir(path.join(root, "src/app"), { recursive: true });
    await fs.writeFile(path.join(root, "pyproject.toml"), '[project]\nname = "app"\n');
    await fs.writeFile(path.join(root, "uv.lock"), ['version = 1', '', '[[package]]', 'name = "typing-extensions"', 'version = "4.12.2"', '', '[[package]]', 'name = "app"', 'version = "0.1.0"', 'source = { editable = "." }', ''].join("\n"));
    await fs.writeFile(path.join(root, "src/app/__init__.py"), "");
    await fs.writeFile(path.join(root, "src/app/core.py"), "import os\nimport typing_extensions\nfrom .missing import gone\nfrom app.absent import nope\nfrom click import echo\n\ndef use():\n    os.getcwd()\n    typing_extensions.get_args()\n    gone()\n    nope()\n    echo()\n");
    const index = await buildIndex(root, { cacheDir: path.join(temporary, "cache") });
    const labels = index.outgoing("src/app/core.py#use").filter((edge) => edge.kind === "calls").sort((a, b) => a.line - b.line)
      .map((edge) => { const r = edge.evidence?.source === "syntax" ? edge.evidence.resolution : undefined; return `${edge.toName}:${r?.status === "unresolved" ? `${r.reason}${r.external === undefined ? "" : ` external:${r.external}`}` : r?.status}`; });
    expect(labels).toEqual(["getcwd:import-target-unresolved external:os", "get_args:import-target-unresolved external:typing_extensions@4.12.2", "gone:import-target-unresolved", "nope:import-target-unresolved", "echo:import-target-unresolved external:click"]);
  });

  it("labels Go standard library and required modules and Rust crates from Cargo.lock", async () => {
    const root = path.join(temporary, "typed"); await fs.mkdir(path.join(root, "rs/src"), { recursive: true });
    await fs.writeFile(path.join(root, "go.mod"), "module example.com/app\n\ngo 1.22\n\nrequire github.com/spf13/cobra v1.8.0\n");
    await fs.writeFile(path.join(root, "main.go"), 'package main\n\nimport (\n\t"fmt"\n\t"net/http"\n\t"github.com/spf13/cobra"\n\t"example.com/app/internal/missing"\n)\n\nfunc main() {\n\tfmt.Println("x")\n\thttp.Get("u")\n\tcobra.Execute()\n\tmissing.Run()\n}\n');
    await fs.writeFile(path.join(root, "rs/Cargo.toml"), '[package]\nname = "rs"\nversion = "0.1.0"\n\n[dependencies]\nserde_json = "1"\n');
    await fs.writeFile(path.join(root, "rs/Cargo.lock"), ['version = 4', '', '[[package]]', 'name = "serde_json"', 'version = "1.0.128"', '', '[[package]]', 'name = "rs"', 'version = "0.1.0"', ''].join("\n"));
    await fs.writeFile(path.join(root, "rs/src/main.rs"), "use serde_json::to_string;\nuse std::collections::HashMap;\nuse flags::parse;\n\nfn main() {\n    to_string(&1);\n    HashMap::new();\n    parse();\n}\n");
    const index = await buildIndex(root, { cacheDir: path.join(temporary, "cache") });
    const label = (edge: OsnovaEdge): string => { const r = edge.evidence?.source === "syntax" ? edge.evidence.resolution : undefined; return `${edge.toName}:${r?.status === "unresolved" ? `${r.reason}${r.external === undefined ? "" : ` external:${r.external}`}` : r?.status}`; };
    const goImports = index.edges.filter((edge) => edge.fromFile === "main.go" && edge.kind === "imports").sort((a, b) => a.line - b.line).map(label);
    expect(goImports).toEqual(["fmt:import-target-unresolved external:fmt", "net/http:import-target-unresolved external:net/http", "github.com/spf13/cobra:import-target-unresolved external:github.com/spf13/cobra@v1.8.0", "example.com/app/internal/missing:import-target-unresolved"]);
    const rsImports = index.edges.filter((edge) => edge.fromFile === "rs/src/main.rs" && edge.kind === "imports").sort((a, b) => a.line - b.line).map(label);
    expect(rsImports).toEqual(["serde_json::to_string:import-target-unresolved external:serde_json@1.0.128", "std::collections::HashMap:import-target-unresolved external:std", "flags::parse:import-target-unresolved"]);
  });

  it("refreshes labels when a lockfile changes", async () => {
    const root = path.join(temporary, "lock"); await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "app" }));
    await fs.writeFile(path.join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/chalk": { version: "5.3.0" } } }));
    await fs.writeFile(path.join(root, "a.ts"), "import chalk from 'chalk';\nexport function use() { chalk(); }\n");
    const cache = path.join(temporary, "cache");
    const { applyChanges, freshness, indexGeneration } = await import("../src/index.js");
    const first = await buildIndex(root, { cacheDir: cache });
    const external = (index: typeof first): string | undefined => { const r = index.outgoing("a.ts#use")[0]?.evidence; return r?.source === "syntax" && r.resolution.status === "unresolved" ? r.resolution.external : undefined; };
    expect(external(first)).toBe("chalk@5.3.0");
    await fs.writeFile(path.join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/chalk": { version: "5.4.1" } } }));
    const report = await freshness(first, root);
    const second = await applyChanges(first, root, report.changed);
    expect(external(second)).toBe("chalk@5.4.1");
    expect(indexGeneration(second)).not.toBe(indexGeneration(first));
    const rebuilt = await buildIndex(root, { cacheDir: path.join(temporary, "cache2") });
    expect(indexGeneration(rebuilt)).toBe(indexGeneration(second));
  });
});
