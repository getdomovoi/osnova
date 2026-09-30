// Type-checker truth for TypeScript: the TypeScript compiler API resolves the callee of every call and `new`
// expression in the corpus (aliases followed) and records its declarations. A site is "in-repo" when a declaration
// is inside the corpus, "external" when every declaration is outside it; sites with no symbol are left out.
// usage: node truth-typescript.mjs --root <checkout> --ts <path to typescript/lib/typescript.js> --output <truth.json>
//        [--paths <paths.json>] [--corpus <id>]
// paths.json maps module specifiers to corpus-relative files, like tsconfig "paths" (see zod-paths.json).
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const { values } = parseArgs({ options: { root: { type: "string" }, output: { type: "string" }, ts: { type: "string" }, paths: { type: "string" }, corpus: { type: "string" } } });
const ts = (await import(pathToFileURL(values.ts).href)).default;
const root = path.resolve(values.root);

const files = [];
const walk = async (dir) => {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) files.push(full);
  }
};
await walk(root);

const options = {
  target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowJs: true, checkJs: false, skipLibCheck: true, noEmit: true,
  strict: false, allowImportingTsExtensions: true, jsx: ts.JsxEmit.Preserve,
  baseUrl: root,
  paths: values.paths ? Object.fromEntries(Object.entries(JSON.parse(await fs.readFile(values.paths, "utf8"))).map(([k, v]) => [k, v.map((p) => path.join(root, p))])) : {},
};
const program = ts.createProgram(files, options);
const checker = program.getTypeChecker();
const rel = (p) => path.relative(root, p).split(path.sep).join("/");
const inRepo = (p) => !p.includes("node_modules") && p.startsWith(root + path.sep);

const entries = [];
let callSites = 0, noSymbol = 0, externalOnly = 0, inRepoDecided = 0, complexCallee = 0;

for (const source of program.getSourceFiles()) {
  if (!inRepo(source.fileName) || source.isDeclarationFile) continue;
  const file = rel(source.fileName);
  const visit = (node) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      callSites += 1;
      const expr = node.expression;
      let ident = null;
      if (ts.isIdentifier(expr)) ident = expr;
      else if (ts.isPropertyAccessExpression(expr)) ident = expr.name;
      if (ident === null) complexCallee += 1;
      else {
        const pos = source.getLineAndCharacterOfPosition(ident.getStart(source));
        let symbol = checker.getSymbolAtLocation(ident);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
          try { symbol = checker.getAliasedSymbol(symbol); } catch { /* keep original */ }
        }
        const decls = (symbol?.getDeclarations() ?? []).map((d) => {
          const sf = d.getSourceFile();
          return { file: sf.fileName, line: sf.getLineAndCharacterOfPosition(d.getStart(sf)).line + 1 };
        });
        if (decls.length === 0) noSymbol += 1;
        else {
          const local = decls.filter((d) => inRepo(d.file)).map((d) => ({ file: rel(d.file), line: d.line }));
          if (local.length === 0) { externalOnly += 1; entries.push({ file, line: pos.line + 1, name: ident.text, verdict: "external", defs: [] }); }
          else { inRepoDecided += 1; entries.push({ file, line: pos.line + 1, name: ident.text, verdict: "in-repo", defs: local }); }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

await fs.writeFile(values.output, JSON.stringify({
  schemaVersion: 1, oracle: "typescript", oracleVersion: ts.version, corpus: values.corpus ?? null,
  method: "ts.createProgram over every .ts/.tsx in the corpus; for each CallExpression/NewExpression the callee identifier (or property-access name) is resolved with checker.getSymbolAtLocation, aliases followed with getAliasedSymbol, and every declaration recorded; a site is 'in-repo' when at least one declaration is inside the corpus, 'external' when every declaration is outside it, and undecided when no symbol resolves",
  stats: { callSites, complexCallee, noSymbol, externalOnly, inRepoDecided, files: files.length },
  entries,
}, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ oracle: "typescript", version: ts.version, callSites, complexCallee, noSymbol, externalOnly, inRepoDecided }));
