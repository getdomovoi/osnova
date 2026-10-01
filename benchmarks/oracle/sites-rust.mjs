// Enumerates every Rust call site in a corpus for truth-rust.mjs, with the tree-sitter Rust grammar Osnova uses.
// For each call_expression the callee identifier is located: a plain name, the last segment of a path (`a::b()`), the
// field of a method call (`x.m()`), or the same inside a turbofish (`f::<T>()`). Calls inside macro invocations are
// token trees to the grammar and are not listed. Columns are UTF-16 code units, which is what LSP positions count.
// usage: node benchmarks/oracle/sites-rust.mjs <checkout> <sites.json>
import { promises as fs } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { Parser, Language } from "web-tree-sitter";

const require = createRequire(import.meta.url);
const [rootArg, out] = process.argv.slice(2);
if (!rootArg || !out) throw new Error("usage: sites-rust.mjs <checkout> <sites.json>");
const root = path.resolve(rootArg);

await Parser.init({ locateFile: () => require.resolve("web-tree-sitter/tree-sitter.wasm") });
const parser = new Parser();
parser.setLanguage(await Language.load(require.resolve("tree-sitter-wasms/out/tree-sitter-rust.wasm")));

const files = [];
const walk = async (dir) => {
  const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "target" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.isFile() && entry.name.endsWith(".rs")) files.push(full);
  }
};
await walk(root);

const callee = (fn) => {
  if (fn === null) return null;
  switch (fn.type) {
    case "identifier": return fn;
    case "scoped_identifier": return fn.childForFieldName("name");
    case "field_expression": return fn.childForFieldName("field");
    case "generic_function": return callee(fn.childForFieldName("function"));
    default: return null;
  }
};

const sites = [];
const withSyntaxErrors = [];
for (const full of files) {
  const file = path.relative(root, full).split(path.sep).join("/");
  const source = await fs.readFile(full, "utf8");
  const tree = parser.parse(source);
  if (tree === null) continue;
  if (tree.rootNode.hasError) withSyntaxErrors.push(file);
  const lineStarts = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === "\n") lineStarts.push(i + 1);
  const stack = [tree.rootNode];
  const found = [];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.type === "call_expression") {
      const name = callee(node.childForFieldName("function"));
      if (name !== null && /^(r#)?[A-Za-z_][A-Za-z0-9_]*$/.test(name.text)) {
        const line = name.startPosition.row + 1;
        found.push({ file, line, character: name.startIndex - lineStarts[line - 1], name: name.text });
      }
    }
    for (let i = node.childCount - 1; i >= 0; i -= 1) stack.push(node.child(i));
  }
  found.sort((a, b) => a.line - b.line || a.character - b.character);
  sites.push(...found);
  tree.delete();
}

await fs.writeFile(out, JSON.stringify({ files: files.length, sites, withSyntaxErrors }) + "\n", { flag: "wx" });
console.log(JSON.stringify({ files: files.length, sites: sites.length, withSyntaxErrors: withSyntaxErrors.length }));
