import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index.js";

let temporary: string; let builds = 0;
beforeEach(async () => { temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-packages-")); builds = 0; });
afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }); });
async function build(files: Record<string, string>) {
  builds += 1;
  const root = path.join(temporary, `ws${builds}`); await fs.mkdir(root);
  for (const [name, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), text); }
  return buildIndex(root, { cacheDir: path.join(temporary, `cache${builds}`) });
}
const imports = (index: Awaited<ReturnType<typeof build>>, file: string) =>
  Object.fromEntries(index.edges.filter((edge) => edge.kind === "imports" && edge.fromFile === file).map((edge) => [edge.toName, edge.toFile]));

describe("workspace package imports", () => {
  it("resolves bare specifiers through package.json name and exports, preferring source conditions", async () => {
    const index = await build({
      "package.json": '{"name":"root","workspaces":["packages/*"]}',
      "packages/lib/package.json": '{"name":"lib","exports":{".":{"source":"./src/index.ts","import":"./dist/index.js"},"./sub":"./src/sub.ts","./built":"./dist/built.js","./deep/*":"./src/deep/*.ts","./package.json":"./package.json"}}',
      "packages/lib/src/index.ts": "export function f() {}\n",
      "packages/lib/src/sub.ts": "export function g() {}\n",
      "packages/lib/src/built.ts": "export function b() {}\n",
      "packages/lib/src/deep/one.ts": "export function one() {}\n",
      "packages/plain/package.json": '{"name":"plain","main":"./dist/index.js"}',
      "packages/plain/src/index.ts": "export function p() {}\n",
      "packages/plain/src/extra.ts": "export function x() {}\n",
      "packages/dupe-a/package.json": '{"name":"dupe"}',
      "packages/dupe-a/index.ts": "export function d() {}\n",
      "packages/dupe-b/package.json": '{"name":"dupe"}',
      "packages/dupe-b/index.ts": "export function d() {}\n",
      "packages/app/package.json": '{"name":"app"}',
      "packages/app/src/main.ts": "import { f } from 'lib';\nimport { g } from 'lib/sub';\nimport { b } from 'lib/built';\nimport { one } from 'lib/deep/one';\nimport { p } from 'plain';\nimport { x } from 'plain/extra';\nimport { d } from 'dupe';\nimport react from 'react';\nimport fs from 'node:fs';\nimport missing from 'lib/missing';\nexport function run() { f(); g(); b(); one(); p(); x(); d(); }\n",
    });
    expect(imports(index, "packages/app/src/main.ts")).toEqual({
      lib: "packages/lib/src/index.ts", "lib/sub": "packages/lib/src/sub.ts", "lib/built": undefined, "lib/deep/one": "packages/lib/src/deep/one.ts",
      plain: "packages/plain/src/index.ts", "plain/extra": "packages/plain/src/extra.ts", dupe: undefined, react: undefined, "node:fs": undefined, "lib/missing": undefined,
    });
    const calls = Object.fromEntries(index.outgoing("packages/app/src/main.ts#run").map((edge) => [edge.toName, edge.toSymbol]));
    expect(calls).toEqual({ f: "packages/lib/src/index.ts#f", g: "packages/lib/src/sub.ts#g", b: undefined, one: "packages/lib/src/deep/one.ts#one", p: "packages/plain/src/index.ts#p", x: "packages/plain/src/extra.ts#x", d: undefined });
  });

  it("resolves Python absolute imports through manifest directories and their src layout", async () => {
    const index = await build({
      "pyproject.toml": "[project]\nname = 'pkg'\n",
      "src/pkg/__init__.py": "from .core import run\n",
      "src/pkg/core.py": "def run():\n    return 1\n",
      "tests/test_core.py": "import pkg\nfrom pkg.core import run\nimport os\n\ndef test():\n    run()\n    pkg.run()\n",
      "tools/sub/setup.py": "",
      "tools/sub/toolkit/__init__.py": "def tool():\n    pass\n",
      "tools/sub/scripts/go.py": "from toolkit import tool\n\ndef main():\n    tool()\n",
    });
    expect(imports(index, "tests/test_core.py")).toEqual({ pkg: "src/pkg/__init__.py", "pkg.core": "src/pkg/core.py", os: undefined });
    expect(Object.fromEntries(index.outgoing("tests/test_core.py#test").map((edge) => [edge.toName, edge.toSymbol]))).toEqual({ run: "src/pkg/core.py#run" });
    expect(imports(index, "tools/sub/scripts/go.py")).toEqual({ toolkit: "tools/sub/toolkit/__init__.py" });
  });

  it("reads a package.json that the repository ignore rules hide", async () => {
    const index = await build({
      "packages/lib/.gitignore": "**/package.json\n*.log\n",
      "packages/lib/package.json": '{"name":"lib","exports":{".":{"source":"./src/index.ts"}}}',
      "packages/lib/src/index.ts": "export function f() {}\n",
      "packages/lib/debug.log": "ignored",
      "packages/app/src/main.ts": "import { f } from 'lib';\nexport function run() { f(); }\n",
    });
    expect(index.files.has("packages/lib/package.json")).toBe(true);
    expect(index.files.has("packages/lib/debug.log")).toBe(false);
    expect(imports(index, "packages/app/src/main.ts")).toEqual({ lib: "packages/lib/src/index.ts" });
  });

  it("selects the most specific export pattern, honors null exclusions and tolerates bad exports", async () => {
    const index = await build({
      "packages/pkg/package.json": '{"name":"pkg","exports":{"./*":"./general/*.ts","./feature/*":"./special/*.ts","./private/*":null,"./dist":"./dist/x.js"}}',
      "packages/pkg/general/feature/a.ts": "export function f() {}\n",
      "packages/pkg/general/private/a.ts": "export function f() {}\n",
      "packages/pkg/special/a.ts": "export function f() {}\n",
      "packages/nul/package.json": '{"name":"nul","exports":null}',
      "packages/nul/index.ts": "export function n() {}\n",
      "packages/num/package.json": '{"name":"num","exports":7}',
      "packages/app/main.ts": "import { f } from 'pkg/feature/a';\nimport { g } from 'pkg/private/a';\nimport { n } from 'nul';\nimport { m } from 'num';\nexport function run() { f(); g(); n(); m(); }\n",
    });
    expect(imports(index, "packages/app/main.ts")).toEqual({ "pkg/feature/a": "packages/pkg/special/a.ts", "pkg/private/a": undefined, nul: undefined, num: undefined });
  });

  it("uses only Python manifest roots above the importing file and treats two hits as ambiguous", async () => {
    const index = await build({
      "a/setup.py": "", "a/mod.py": "def f():\n    pass\n",
      "b/setup.py": "", "b/mod.py": "def f():\n    pass\n", "b/app.py": "from mod import f\n\ndef use():\n    f()\n",
      "pyproject.toml": "[project]\nname='x'\n", "src/shared.py": "def s():\n    pass\n", "examples/setup.py": "", "examples/shared.py": "def s():\n    pass\n",
      "app.py": "from shared import s\n\ndef use():\n    s()\n",
      "src/both.py": "def q():\n    pass\n", "both.py": "def q():\n    pass\n", "tests/test_both.py": "from both import q\n\ndef test():\n    q()\n",
    });
    expect(imports(index, "b/app.py")).toEqual({ mod: "b/mod.py" });
    expect(imports(index, "app.py")).toEqual({ shared: "src/shared.py" });
    expect(imports(index, "tests/test_both.py")).toEqual({ both: undefined });
    const named = await build({ "src/setup.py": "", "src/mod.py": "def f():\n    pass\n", "app.py": "from mod import f\n\ndef use():\n    f()\n", "src/inner.py": "from mod import f\n" });
    expect(imports(named, "app.py")).toEqual({ mod: undefined });
    expect(imports(named, "src/inner.py")).toEqual({ mod: "src/mod.py" });
  });
});
