import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index.js";

let temporary: string;
let workspace: string;
let cacheDir: string;

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-go-package-"));
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

const callAt = (index: Awaited<ReturnType<typeof build>>, file: string, line: number, name: string) =>
  index.edges.find((edge) => edge.kind === "calls" && edge.fromFile === file && edge.line === line && edge.toName === name);

describe("a plain Go call names a function of its own package", () => {
  it("takes the function its package declares over one of the same name in another package", async () => {
    const index = await build({
      "go.mod": "module example.com/app\n\ngo 1.22\n",
      "helpers_test.go": "package app\n\nfunc assertNoErr(err error) {}\n",
      "command_test.go": "package app\n\nfunc TestRun() {\n\tassertNoErr(nil)\n}\n",
      "doc/helpers_test.go": "package doc\n\nfunc assertNoErr(err error) {}\n",
    });
    expect(callAt(index, "command_test.go", 4, "assertNoErr")).toMatchObject({ toSymbol: "helpers_test.go#assertNoErr", toFile: "helpers_test.go", evidence: { resolution: { status: "resolved", method: "lexical-definition" } } });
  });

  it("does not take a method of the same name for a plain call", async () => {
    const index = await build({
      "go.mod": "module example.com/app\n\ngo 1.22\n",
      "flags.go": "package app\n\nfunc MarkFlagRequired(name string) error { return nil }\n",
      "command.go": "package app\n\ntype Command struct{}\n\nfunc (c *Command) MarkFlagRequired(name string) error {\n\treturn MarkFlagRequired(name)\n}\n",
    });
    expect(callAt(index, "command.go", 6, "MarkFlagRequired")).toMatchObject({ toSymbol: "flags.go#MarkFlagRequired" });
  });

  it("leaves a call through a local function value to that value, not the package function of its name", async () => {
    const index = await build({
      "go.mod": "module example.com/app\n\ngo 1.22\n",
      "caller.go": "package app\n\nfunc Run() int {\n\tTarget := func() int { return 2 }\n\treturn Target()\n}\n",
      "helper.go": "package app\n\nfunc Target() int { return 1 }\n",
      "other/other.go": "package other\n\nfunc Target() int { return 3 }\n",
    });
    expect(callAt(index, "caller.go", 5, "Target")?.toSymbol).toBeUndefined();
  });

  it("reads the package clause past a comment that spells another one", async () => {
    const index = await build({
      "go.mod": "module example.com/app\n\ngo 1.22\n",
      "caller.go": "package app\n\nimport . \"example.com/app/other\"\n\nfunc Run() int { return Target() }\n",
      "external_test.go": "/*\npackage app\n*/\npackage app_test\n\nfunc Target() int { return 1 }\n",
      "other/other.go": "package other\n\nfunc Target() int { return 2 }\n",
    });
    expect(callAt(index, "caller.go", 5, "Target")?.toSymbol).not.toBe("external_test.go#Target");
  });

  it("does not let a declaration built only in some configurations decide a plain call", async () => {
    const index = await build({
      "go.mod": "module example.com/app\n\ngo 1.22\n",
      "caller.go": "package app\n\nfunc Run() int { return len([]int{1, 2}) + size() }\n",
      "helper.go": "//go:build osnova_never\n\npackage app\n\nfunc len(s []int) int { return 99 }\n",
      "size_windows.go": "package app\n\nfunc size() int { return 1 }\n",
      "other/other.go": "package other\n\nfunc len(s []int) int { return 88 }\n",
    });
    expect(callAt(index, "caller.go", 3, "len")?.toSymbol).toBeUndefined();
    expect(callAt(index, "caller.go", 3, "size")?.toSymbol).toBeUndefined();
  });

  it("treats every name of a grouped parameter, result or range clause as a local that shadows the package function", async () => {
    const index = await build({
      "go.mod": "module example.com/app\n\ngo 1.22\n",
      "params.go": "package app\n\nfunc RunParams(Other, Target func() int) int { return Target() }\n",
      "results.go": "package app\n\nfunc RunResults() (Other, Target func() int) {\n\tTarget = func() int { return 2 }\n\tTarget()\n\treturn\n}\n",
      "ranges.go": "package app\n\nfunc RunRange() int {\n\tfor _, Target := range []func() int{func() int { return 2 }} {\n\t\treturn Target()\n\t}\n\treturn Target()\n}\n",
      "helper.go": "package app\n\nfunc Target() int { return 1 }\n",
      "other/other.go": "package other\n\nfunc Target() int { return 3 }\n",
    });
    expect(callAt(index, "params.go", 3, "Target")?.toSymbol).toBeUndefined();
    expect(callAt(index, "results.go", 5, "Target")?.toSymbol).toBeUndefined();
    expect(callAt(index, "ranges.go", 5, "Target")?.toSymbol).toBeUndefined();
    // After the loop the range variable is out of scope, so the package function is called.
    expect(callAt(index, "ranges.go", 7, "Target")?.toSymbol).toBe("helper.go#Target");
  });

  it("reads a Unicode package name and one written after a comment, and never takes an unread name as a shared package", async () => {
    const index = await build({
      "go.mod": "module example.com/app\n\ngo 1.22\n",
      "u/caller.go": "package α\n\nimport . \"example.com/app/other\"\n\nfunc Run() int { return Target() }\n",
      "u/external_test.go": "package α_test\n\nfunc Target() int { return 1 }\n",
      "c/caller.go": "package /* note */ app\n\nimport . \"example.com/app/other\"\n\nfunc Run() int { return Target() }\n",
      "c/external_test.go": "package /* note */ app_test\n\nfunc Target() int { return 1 }\n",
      "other/other.go": "package other\n\nfunc Target() int { return 2 }\n",
    });
    expect(callAt(index, "u/caller.go", 5, "Target")?.toSymbol).not.toBe("u/external_test.go#Target");
    expect(callAt(index, "c/caller.go", 5, "Target")?.toSymbol).not.toBe("c/external_test.go#Target");
  });
});
