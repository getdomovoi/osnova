import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index.js";

let temporary: string;
beforeEach(async () => { temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-proto-")); });
afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }); });

describe("fields named like Object.prototype members", () => {
  it("does not read the prototype when a chain names constructor or toString", async () => {
    await fs.writeFile(path.join(temporary, "a.ts"), [
      "export class Base { name = \"\"; }",
      "export class Http extends Base {",
      "  describe(): string {",
      "    const parts = this.constructor.name.match(/[A-Z]/g);",
      "    const text = this.toString.call(this);",
      "    return `${parts?.join(\"\")}${text}`;",
      "  }",
      "}",
      "",
    ].join("\n"));
    const index = await buildIndex(temporary, { cacheDir: path.join(temporary, "cache") });
    const calls = index.edges.filter((edge) => edge.kind === "calls" && edge.fromFile === "a.ts").map((edge) => `${edge.toName}:${edge.evidence?.source === "syntax" ? edge.evidence.resolution.status : "?"}`);
    expect(calls).toContain("match:unresolved");
    expect(calls).toContain("call:unresolved");
  });
});
