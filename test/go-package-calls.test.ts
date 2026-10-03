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
});
