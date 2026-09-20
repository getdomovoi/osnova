import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index.js";

let temporary: string;
let workspace: string;
let cacheDir: string;

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-namespace-"));
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

describe("namespace members declared as constants", () => {
  it("resolves a call to a namespace constant whose initializer is not a function expression", async () => {
    const index = await build({
      "helpers/util.ts": `export namespace util {
  export const isInteger: (value: unknown) => boolean =
    typeof Number.isInteger === "function" ? (value) => typeof value === "number" : () => false;
  export function joinValues(values: string[]): string { return values.join(","); }
}
`,
      "types.ts": `import { util } from "./helpers/util.js";
export function check(input: unknown): boolean {
  if (!util.isInteger(input)) return false;
  return util.joinValues(["a"]).length > 0;
}
`,
    });

    const calls = index.outgoing("types.ts#check");
    const constantCall = calls.find((edge) => edge.toName === "isInteger");
    const functionCall = calls.find((edge) => edge.toName === "joinValues");

    expect(functionCall?.toSymbol).toBe("helpers/util.ts#util.joinValues");
    expect(constantCall?.toSymbol).toBe("helpers/util.ts#util.isInteger");
    expect(constantCall?.evidence).toMatchObject({ resolution: { status: "resolved", method: "receiver-hint" } });
  });

  it("leaves a class data field unresolved rather than guessing a call target", async () => {
    const index = await build({
      "holder.ts": `export class Holder {
  static handler: (value: number) => number =
    Math.random() > 0.5 ? (value) => value : (value) => value + 1;
}
`,
      "caller.ts": `import { Holder } from "./holder.js";
export function run(): number { return Holder.handler(1); }
`,
    });

    const call = index.outgoing("caller.ts#run").find((edge) => edge.toName === "handler");
    expect(call?.toSymbol).toBeUndefined();
  });
});
