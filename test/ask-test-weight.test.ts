import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { OsnovaIndexImpl } from "../src/index/indexImpl.js";
import { ask } from "../src/query/ask.js";
import type { FileCard, OsnovaSymbol } from "../src/types.js";

function card(path: string, text: string, symbols: readonly [string, string, number, number][]): FileCard {
  return { path, text, hash: createHash("sha256").update(text).digest("hex"), language: "python", size: text.length, lineCount: text.split("\n").length,
    symbols: symbols.map(([name, qualified, start, end]): OsnovaSymbol => ({ name, qualifiedName: `${path}#${qualified}`, file: path, kind: "function",
      signature: `def ${name}()`, lineCount: end - start + 1, span: { startLine: start, endLine: end, startCol: 0, endCol: 1 } })) };
}

const source = card("src/writer.py", "def render_imports(items):\n    # sorted migration imports for the writer\n    return sorted(items)\n", [["render_imports", "render_imports", 1, 3]]);
const test = card("tests/test_writer.py",
  "def test_sorted_imports():\n    # migration writer imports are sorted; migration writer imports once\n    assert render_imports(['b', 'a']) == ['a', 'b']\n",
  [["test_sorted_imports", "test_sorted_imports", 1, 3]]);
const index = new OsnovaIndexImpl("/fixture", new Map([source, test].map((file) => [file.path, file])), []);

it("ranks the definition above tests that repeat its words unless the question asks about tests", () => {
  expect(ask(index, "migration writer imports sorted").hits[0]?.file).toBe("src/writer.py");
  expect(ask(index, "migration writer imports sorted test").hits[0]?.file).toBe("tests/test_writer.py");
  expect(ask(index, "test_sorted_imports").hits[0]?.symbol?.name).toBe("test_sorted_imports");
});
