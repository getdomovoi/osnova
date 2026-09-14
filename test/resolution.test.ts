import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { buildIndex } from "../src/index/build.js";
import { resolveEdges } from "../src/index/resolve.js";
import { loadIndex } from "../src/api.js";
import { resolveCacheDir } from "../src/cache/cache.js";
import type { OsnovaIndex } from "../src/types.js";

describe("python import resolution", () => {
  let index: OsnovaIndex;
  beforeAll(async () => {
    index = await buildIndex(path.join(import.meta.dirname, "fixtures", "sample-repo"), {
      cacheDir: ".tmp-coverage-cache",
    });
  });

  it("resolves from-import of a module file", () => {
    const imports = index.edges.filter(
      (e) => e.fromFile === "src/pyclient.py" && e.kind === "imports",
    );
    expect(imports.some((e) => e.toFile === "src/pyhelpers/helper.py")).toBe(true);
    expect(imports.some((e) => e.toFile === "src/pyhelpers/__init__.py")).toBe(true);
  });

  it("resolves from-import as references to imported names", () => {
    const refs = index.edges.filter(
      (e) => e.fromFile === "src/pyclient.py" && e.kind === "references",
    );
    expect(refs.some((e) => e.toSymbol === "src/pyhelpers/helper.py#double")).toBe(true);
    const calls = index.outgoing("src/pyclient.py#apply").map((e) => e.toSymbol);
    expect(calls).toContain("src/pyhelpers/helper.py#double");
  });

  it("resolves dotted module imports to package init", () => {
    const relative = index.edges.filter(
      (e) => e.fromFile === "src/pyrelative.py" && e.kind === "imports",
    );
    expect(relative.some((e) => e.toFile === "src/pyhelpers/__init__.py")).toBe(true);
  });

  it("resolves absolute module paths", () => {
    const imports = index.edges.filter(
      (e) => e.fromFile === "src/pyclient.py" && e.kind === "imports",
    );
    expect(imports.some((e) => e.toName === "json")).toBe(true);
    expect(imports.some((e) => (e.toFile ?? "").includes("json"))).toBe(false);
  });
});

describe("resolveNodeSpecifier candidate walking", () => {
  const known = new Set(["a/app.ts", "a/util.ts", "a/util/index.ts", "a/legacy.mts", "a/mod/index.js"]);

  it("prefers exact file then extension then index candidates", () => {
    expect(resolveEdges).toBeDefined();
    const direct = resolveImportFor("a/app.ts", "./util", known);
    expect(direct).toBe("a/util.ts");
    expect(resolveImportFor("a/app.ts", "./util/index.js", known)).toBe("a/util/index.ts");
    expect(resolveImportFor("a/app.ts", "./mod", known)).toBe("a/mod/index.js");
    expect(resolveImportFor("a/app.ts", "./legacy.mjs", known)).toBe("a/legacy.mts");
  });

  it("returns undefined for unmatched specifiers", () => {
    expect(resolveImportFor("a/app.ts", "./missing", known)).toBeUndefined();
    expect(resolveImportFor("a/app.ts", "lodash", known)).toBeUndefined();
  });
});

function resolveImportFor(fromFile: string, spec: string, known: Set<string>): string | undefined {
  const edges = resolveEdges({
    root: "/",
    files: new Map(
      [...known].map((p) => [
        p,
        { path: p, language: "typescript", hash: "x", size: 0, lineCount: 0, text: "", symbols: [] },
      ]),
    ),
    rawEdges: new Map([[fromFile, [{ kind: "imports", toName: spec, line: 1, enclosing: "" }]]]),
  } as never);
  const edge = edges[0];
  return edge?.toFile;
}

describe("loadIndex frozen API", () => {
  it("round-trips an index through the default cache dir override", async () => {
    process.env.OSNOVA_CACHE_DIR = ".tmp-coverage-cache";
    try {
      const loaded = await loadIndex(path.join(import.meta.dirname, "fixtures", "sample-repo"));
      expect(loaded).toBeDefined();
      expect(loaded?.symbols.has("src/util.ts#pad")).toBe(true);
      const missing = await loadIndex("/definitely-not-a-workspace", {
        cacheDir: resolveCacheDir(".tmp-coverage-cache"),
      });
      expect(missing).toBeUndefined();
    } finally {
      delete process.env.OSNOVA_CACHE_DIR;
    }
  });
});
