import path from "node:path";
import type { Callee, CardLanguage, EdgeResolution, ExportHop, FileCard, OsnovaEdge, OsnovaSymbol, ReceiverBasis, ReceiverMode, ReceiverOwner, ReturnBinding, SymbolBinding } from "../types.js";
import { qualifiedNameOf } from "./indexImpl.js";
import type { RawEdgeItem } from "./indexImpl.js";
import { collectLockfiles, externalLabel } from "./external.js";
import type { Lockfiles } from "./external.js";

const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
const HOLDER_KINDS = new Set(["class", "interface", "module", "struct", "enum", "trait"]);
const isHolder = (symbol: OsnovaSymbol): boolean => HOLDER_KINDS.has(symbol.kind);
const VALUE_REFERENCE_KINDS: ReadonlySet<string> = new Set(["function", "method", "class"]);
// Languages whose receiver hints name a type without an import binding; a type not declared in the
// file may still be the single declaration of that name in the same language family.
const TYPED_FAMILY = new Set(["go", "rust", "java", "c_sharp"]);
// Builtin type names a receiver annotation or literal can carry: never a holder the index could define.
const BUILTIN_TYPES = new Set(["string", "number", "boolean", "bigint", "symbol", "Array", "Map", "Set", "WeakMap", "WeakSet", "Promise", "RegExp", "Date", "Error", "Object", "Function", "str", "list", "dict", "set", "tuple", "int", "float", "bool", "bytes"]);
const goPackages = new WeakMap<FileCard, string>();
// The package clause separates an external _test package from the production package in one directory.
function goPackageOf(card: FileCard): string {
  const cached = goPackages.get(card);
  if (cached !== undefined) return cached;
  const name = card.text.match(/^\s*package\s+(\w+)/m)?.[1] ?? "";
  goPackages.set(card, name);
  return name;
}

export function languageFamily(language: CardLanguage | undefined): string | undefined {
  if (language === "typescript" || language === "tsx" || language === "javascript") return "javascript";
  if (language === "c" || language === "cpp") return "c";
  if (language === "java" || language === "kotlin" || language === "scala") return "java";
  return language;
}

function resolveNodeSpecifier(
  fromFile: string,
  spec: string,
  knownFiles: ReadonlySet<string>,
): string | undefined {
  const dir = path.posix.dirname(fromFile);
  const base = path.posix.normalize(path.posix.join(dir, spec));
  const candidates = [base];
  for (const ext of TS_EXTENSIONS) candidates.push(base + ext);
  for (const ext of TS_EXTENSIONS) candidates.push(`${base}/index${ext}`);
  if (base.endsWith(".js") || base.endsWith(".mjs") || base.endsWith(".cjs")) {
    const swapped = base.replace(/\.(m|c)?js$/, ".ts");
    candidates.push(swapped, swapped.replace(/\.ts$/, ".mts"), base.replace(/\.js$/, ".tsx"));
  }
  for (const candidate of candidates) {
    if (knownFiles.has(candidate)) return candidate;
  }
  return undefined;
}

function resolvePythonSpecifier(
  fromFile: string,
  spec: string,
  knownFiles: ReadonlySet<string>,
  roots: readonly PythonRoot[],
): string | undefined {
  let up = 0;
  let rest = spec;
  while (rest.startsWith(".")) {
    up += 1;
    rest = rest.slice(1);
  }
  const fromDir = path.posix.dirname(fromFile);
  let baseDir = fromDir;
  for (let i = 1; i < up; i += 1) {
    if (baseDir === ".") return undefined;
    baseDir = path.posix.dirname(baseDir);
  }
  const parts = rest.length > 0 ? rest.split(".") : [];
  if (up === 0 && parts.length === 0) return undefined;
  if (up > 0) {
    const modulePath = path.posix.join(baseDir, ...parts);
    const init = path.posix.join(modulePath, "__init__.py");
    if (knownFiles.has(init)) return init;
    return knownFiles.has(`${modulePath}.py`) ? `${modulePath}.py` : undefined;
  }
  // Only manifest roots above the importing file count, nearest first; a module found under two
  // of them is ambiguous and stays unresolved.
  const ancestors = roots.filter((root) => root.manifest === "" || fromDir === root.manifest || fromDir.startsWith(`${root.manifest}/`))
    .sort((a, b) => b.manifest.length - a.manifest.length);
  const found = new Set<string>();
  for (const root of ancestors) {
    const modulePath = path.posix.join(root.dir, ...parts);
    const init = path.posix.join(modulePath, "__init__.py");
    if (knownFiles.has(init)) found.add(init);
    else if (knownFiles.has(`${modulePath}.py`)) found.add(`${modulePath}.py`);
  }
  return found.size === 1 ? [...found][0] : undefined;
}

interface PackageEntry { readonly dir: string; readonly exports: unknown; readonly main: readonly string[] }

// Workspace packages let a bare specifier such as "zod/v4" or "click" resolve to indexed source:
// package.json name and exports (any condition, source files preferred) for the JavaScript family,
// and manifest directories plus their src layout for Python.
export interface PythonRoot { readonly dir: string; readonly manifest: string }
export interface WorkspaceContext {
  readonly packages: ReadonlyMap<string, PackageEntry | null>;
  readonly pythonRoots: readonly PythonRoot[];
  readonly goModules: ReadonlyMap<string, string>;
  readonly cargoRoots: readonly string[];
  /** Workspace crate name (hyphens as underscores, as a Rust path spells it) to the crate directory. */
  readonly cargoPackages: ReadonlyMap<string, string>;
  /** Crate root file to the aliases its `pub extern crate x as y;` and `pub use x as y;` lines give other crates. */
  readonly crateAliases: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Crate directory to its source directory when a `[lib]` or `[[bin]]` `path` moves the root out of `src`. */
  readonly cargoSrc: ReadonlyMap<string, string>;
  /** Lockfile directory to the package versions its lockfiles pin, for labelling external imports. */
  readonly lockfiles: ReadonlyMap<string, Lockfiles>;
  /** Crate directory to the crate names its Cargo.toml dependency tables declare. */
  readonly cargoDependencies: ReadonlyMap<string, ReadonlySet<string>>;
}

export function workspaceContext(files: ReadonlyMap<string, FileCard>): WorkspaceContext {
  const packages = new Map<string, PackageEntry | null>();
  const pythonRoots = new Map<string, PythonRoot>([["\0", { dir: "", manifest: "" }]]);
  const goModules = new Map<string, string>();
  const cargoRoots: string[] = [];
  const cargoPackages = new Map<string, string>();
  const crateAliases = new Map<string, Map<string, string>>();
  const cargoSrc = new Map<string, string>();
  const cargoDependencies = new Map<string, Set<string>>();
  for (const [file, card] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (card.language === "rust" && /^(lib|main)\.rs$/.test(path.posix.basename(file))) {
      const aliases = new Map<string, string>();
      for (const match of card.text.matchAll(/^\s*pub(?:\([^)]*\))?\s+(?:extern\s+crate|use)\s+(\w+)\s+as\s+(\w+)\s*;/gm)) if (match[1] !== undefined && match[2] !== undefined) aliases.set(match[2], match[1]);
      if (aliases.size > 0) crateAliases.set(file, aliases);
    }
    const base = path.posix.basename(file);
    const dir = path.posix.dirname(file) === "." ? "" : path.posix.dirname(file);
    if (base === "package.json") {
      let json: unknown;
      try { json = JSON.parse(card.text); } catch { continue; }
      if (typeof json !== "object" || json === null) continue;
      const record = json as Record<string, unknown>;
      if (typeof record.name !== "string" || record.name.length === 0) continue;
      const main = ["module", "main", "types"].map((key) => record[key]).filter((value): value is string => typeof value === "string");
      packages.set(record.name, packages.has(record.name) ? null : { dir, exports: record.exports, main });
    } else if (base === "go.mod") {
      const match = card.text.match(/^\s*module\s+(\S+)/m);
      if (match?.[1] !== undefined) goModules.set(match[1], dir);
    } else if (base === "Cargo.toml") {
      cargoRoots.push(dir);
      const packageSection = /^\s*\[package\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m.exec(card.text)?.[1];
      const name = packageSection === undefined ? undefined : /^\s*name\s*=\s*"([^"]+)"/m.exec(packageSection)?.[1];
      if (name !== undefined) cargoPackages.set(name.replace(/-/g, "_"), dir);
      const target = /^\s*\[(?:lib|\[bin\])\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m.exec(card.text)?.[1];
      const rootPath = target === undefined ? undefined : /^\s*path\s*=\s*"([^"]+)"/m.exec(target)?.[1];
      if (rootPath !== undefined) { const srcDir = path.posix.dirname(path.posix.join(dir, rootPath)); cargoSrc.set(dir, srcDir === "." ? "" : srcDir); }
      const dependencies = new Set<string>();
      for (const table of card.text.matchAll(/^\s*\[(?:workspace\.|target\.[^\]]+\.)?(?:dependencies|dev-dependencies|build-dependencies)\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/gm)) {
        for (const entry of (table[1] ?? "").matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)) if (entry[1] !== undefined) dependencies.add(entry[1].replace(/-/g, "_"));
      }
      for (const entry of card.text.matchAll(/^\s*\[(?:workspace\.|target\.[^\]]+\.)?(?:dependencies|dev-dependencies|build-dependencies)\.([A-Za-z0-9_-]+)\]\s*$/gm)) if (entry[1] !== undefined) dependencies.add(entry[1].replace(/-/g, "_"));
      if (dependencies.size > 0) cargoDependencies.set(dir, dependencies);
    } else if (base === "pyproject.toml" || base === "setup.py" || base === "setup.cfg") {
      pythonRoots.set(`${dir}\0${dir}`, { dir, manifest: dir });
      const src = dir === "" ? "src" : `${dir}/src`;
      for (const known of files.keys()) if (known.startsWith(`${src}/`)) { pythonRoots.set(`${src}\0${dir}`, { dir: src, manifest: dir }); break; }
    }
  }
  return { packages, pythonRoots: [...pythonRoots.values()].sort((a, b) => a.manifest < b.manifest ? -1 : a.manifest > b.manifest ? 1 : a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0), goModules, cargoRoots: cargoRoots.sort(), cargoPackages, crateAliases, cargoSrc, lockfiles: collectLockfiles(files), cargoDependencies };
}

function exportTargets(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) exportTargets(item, out);
  else if (typeof value !== "object" || value === null) return out;
  else for (const item of Object.values(value)) exportTargets(item, out);
  return out;
}

function resolvePackageFile(dir: string, target: string, knownFiles: ReadonlySet<string>): string | undefined {
  const joined = path.posix.normalize(path.posix.join(dir, target));
  if (joined.startsWith("..")) return undefined;
  const candidates = [joined];
  const stripped = joined.replace(/\.d\.(c|m)?ts$/, "").replace(/\.(m|c)?jsx?$/, "");
  if (stripped !== joined) for (const ext of [".ts", ".tsx", ".mts", ".cts"]) candidates.push(stripped + ext);
  return candidates.find((candidate) => knownFiles.has(candidate)) ?? resolveNodeSpecifier("package.json", `./${joined}`, knownFiles);
}

function resolveBareSpecifier(spec: string, knownFiles: ReadonlySet<string>, context: WorkspaceContext): string | undefined {
  let name: string | undefined;
  for (const candidate of context.packages.keys()) {
    if ((spec === candidate || spec.startsWith(`${candidate}/`)) && (name === undefined || candidate.length > name.length)) name = candidate;
  }
  if (name === undefined) return undefined;
  const entry = context.packages.get(name);
  if (entry === null || entry === undefined) return undefined;
  const subpath = spec === name ? "." : `./${spec.slice(name.length + 1)}`;
  const exportsField = entry.exports;
  if (exportsField !== undefined) {
    if (exportsField === null || (typeof exportsField !== "string" && typeof exportsField !== "object")) return undefined;
    const table: Record<string, unknown> = typeof exportsField === "string" || Array.isArray(exportsField) || !Object.keys(exportsField).some((key) => key.startsWith("."))
      ? { ".": exportsField } : exportsField as Record<string, unknown>;
    const targets: string[] = [];
    if (Object.prototype.hasOwnProperty.call(table, subpath)) {
      if (table[subpath] === null) return undefined;
      exportTargets(table[subpath], targets);
    } else {
      // Node picks the pattern with the longest literal prefix; a null winner excludes the subpath.
      let best: { prefix: string; suffix: string; value: unknown } | undefined;
      for (const [key, value] of Object.entries(table)) {
        const star = key.indexOf("*");
        if (star < 0 || key.indexOf("*", star + 1) >= 0) continue;
        const prefix = key.slice(0, star), suffix = key.slice(star + 1);
        if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix) || subpath.length < prefix.length + suffix.length) continue;
        if (best === undefined || prefix.length > best.prefix.length || (prefix.length === best.prefix.length && suffix.length > best.suffix.length)) best = { prefix, suffix, value };
      }
      if (best === undefined || best.value === null) return undefined;
      const filler = subpath.slice(best.prefix.length, subpath.length - best.suffix.length);
      for (const target of exportTargets(best.value)) targets.push(target.split("*").join(filler));
    }
    const ordered = [...targets.filter((target) => /\.(ts|tsx|mts|cts)$/.test(target) && !/\.d\.(c|m)?ts$/.test(target)), ...targets.filter((target) => !/\.(ts|tsx|mts|cts)$/.test(target) || /\.d\.(c|m)?ts$/.test(target))];
    for (const target of ordered) { const found = resolvePackageFile(entry.dir, target, knownFiles); if (found !== undefined) return found; }
    return undefined;
  }
  const rest = subpath === "." ? "" : subpath.slice(2);
  const bases = rest === "" ? [...entry.main, "./index", "./src/index"] : [`./${rest}`, `./src/${rest}`];
  for (const target of bases) { const found = resolvePackageFile(entry.dir, target, knownFiles); if (found !== undefined) return found; }
  return undefined;
}

function resolveImportTarget(
  language: string,
  fromFile: string,
  spec: string,
  knownFiles: ReadonlySet<string>,
  context: WorkspaceContext,
): string | undefined {
  if (language === "typescript" || language === "tsx" || language === "javascript") {
    if (spec.startsWith("./") || spec.startsWith("../")) return resolveNodeSpecifier(fromFile, spec, knownFiles);
    if (spec.startsWith("node:") || spec.startsWith("/") || spec.startsWith("#")) return undefined;
    return resolveBareSpecifier(spec, knownFiles, context);
  }
  if (language === "python") {
    return resolvePythonSpecifier(fromFile, spec, knownFiles, context.pythonRoots);
  }
  if (language === "go") return resolveGoPackage(spec, knownFiles, context);
  if (language === "java") {
    // a.b.Server names the file a/b/Server.java under some source root.
    const suffix = `/${spec.split(".").join("/")}.java`;
    const matches = [...knownFiles].filter((file) => file.endsWith(suffix) || file === suffix.slice(1));
    return matches.length === 1 ? matches[0] : undefined;
  }
  if (language === "rust") return resolveRustModule(fromFile, spec, knownFiles, context);
  return undefined;
}

// A Go import names a package directory. The target is the first Go file in it (sorted, test files
// last) and export lookup gathers top-level symbols from every Go file in that directory.
function resolveGoPackage(spec: string, knownFiles: ReadonlySet<string>, context: WorkspaceContext): string | undefined {
  let module: string | undefined;
  for (const candidate of context.goModules.keys()) if ((spec === candidate || spec.startsWith(`${candidate}/`)) && (module === undefined || candidate.length > module.length)) module = candidate;
  if (module === undefined) return undefined;
  const base = context.goModules.get(module) ?? "";
  const rest = spec === module ? "" : spec.slice(module.length + 1);
  const dir = [base, rest].filter((part) => part.length > 0).join("/");
  const prefix = dir === "" ? "" : `${dir}/`;
  const members = [...knownFiles].filter((file) => file.startsWith(prefix) && file.endsWith(".go") && !file.slice(prefix.length).includes("/"))
    .sort((a, b) => Number(a.endsWith("_test.go")) - Number(b.endsWith("_test.go")) || (a < b ? -1 : a > b ? 1 : 0));
  return members[0];
}

// A Rust path resolves against the crate whose Cargo.toml is nearest above the file: crate:: from
// its src directory, super:: and self:: from the module directory of the importing file, and any
// other head against the workspace crate of that package name. The
// longest file prefix wins, so an inline module inside a file still lands on that file.
function resolveRustModule(fromFile: string, spec: string, knownFiles: ReadonlySet<string>, context: WorkspaceContext): string | undefined {
  const segments = spec.split("::").filter((part) => part.length > 0);
  const head = segments[0];
  if (head === undefined) return undefined;
  const fromDir = path.posix.dirname(fromFile) === "." ? "" : path.posix.dirname(fromFile);
  const srcOf = (crate: string): string => context.cargoSrc.get(crate) ?? (crate === "" ? "src" : `${crate}/src`);
  const ownCrate = (): string | undefined => context.cargoRoots.filter((root) => root === "" || fromFile.startsWith(`${root}/`)).sort((a, b) => b.length - a.length)[0];
  const base = path.posix.basename(fromFile);
  const ownDir = base === "mod.rs" || base === "lib.rs" || base === "main.rs" ? fromDir : path.posix.join(fromDir, base.replace(/\.rs$/, ""));
  let start: string;
  let rest: string[];
  if (head === "crate") {
    const crate = ownCrate();
    if (crate === undefined) return undefined;
    start = srcOf(crate);
    rest = segments.slice(1);
  } else if (context.cargoPackages.get(head) === undefined && head !== "self" && head !== "super" && (knownFiles.has(path.posix.join(ownDir, `${head}.rs`)) || knownFiles.has(path.posix.join(ownDir, head, "mod.rs")))) {
    // `flags::parse::lookup()` with `mod flags;` in this file: a sibling module named without `self::`.
    start = ownDir;
    rest = segments;
  } else if (head === "self" || head === "super") {
    let dir = ownDir;
    let index = 0;
    while (segments[index] === "super" || segments[index] === "self") { if (segments[index] === "super") dir = path.posix.dirname(dir) === "." ? "" : path.posix.dirname(dir); index += 1; }
    start = dir;
    rest = segments.slice(index);
    // `self` alone is this file; `self::inner::X` with no file for `inner` names an inline module of this file.
    if (dir === ownDir && (rest.length === 0 || (!knownFiles.has(path.posix.join(start, `${rest[0]}.rs`)) && !knownFiles.has(path.posix.join(start, rest[0] ?? "", "mod.rs"))))) return fromFile;
  } else {
    // `grep_matcher::LineTerminator`: another crate of this workspace, by its package name.
    const crate = context.cargoPackages.get(head);
    if (crate === undefined) return undefined;
    start = srcOf(crate);
    rest = segments.slice(1);
    // A facade crate names another crate under an alias (`pub extern crate grep_printer as printer;`), so
    // `grep::printer::X` continues from the aliased crate's root. Each hop consumes a segment, so it ends.
    for (let hop = 0; hop < segments.length; hop += 1) {
      const next = rest[0] === undefined ? undefined : context.crateAliases.get(`${start}/lib.rs`)?.get(rest[0]);
      const aliased = next === undefined ? undefined : context.cargoPackages.get(next);
      if (aliased === undefined) break;
      start = srcOf(aliased);
      rest = rest.slice(1);
    }
  }
  for (let take = rest.length; take >= 0; take -= 1) {
    const modulePath = path.posix.join(start, ...rest.slice(0, take));
    const candidates = take === 0 ? [`${modulePath}/lib.rs`, `${modulePath}/main.rs`, `${modulePath}/mod.rs`] : [`${modulePath}.rs`, `${modulePath}/mod.rs`];
    for (const candidate of candidates) if (knownFiles.has(candidate)) return candidate;
  }
  return undefined;
}

export interface ResolutionInput {
  readonly root: string;
  readonly files: ReadonlyMap<string, FileCard>;
  readonly rawEdges: ReadonlyMap<string, readonly RawEdgeItem[]>;
  readonly reuse?: EdgeReuse;
}

export interface EdgeReuse {
  readonly resolve: ReadonlySet<string>;
  readonly edges: readonly OsnovaEdge[];
}

function groupEdgesByFile(edges: readonly OsnovaEdge[]): Map<string, OsnovaEdge[]> {
  const out = new Map<string, OsnovaEdge[]>();
  for (const edge of edges) {
    const list = out.get(edge.fromFile);
    if (list === undefined) out.set(edge.fromFile, [edge]);
    else list.push(edge);
  }
  return out;
}

export function resolveEdges(input: ResolutionInput): OsnovaEdge[] {
  const { files, rawEdges, reuse } = input;
  const reusable = reuse === undefined ? undefined : groupEdgesByFile(reuse.edges);

  const symbolsByName = new Map<string, OsnovaSymbol[]>();
  const allSymbols: OsnovaSymbol[] = [];
  for (const card of [...files.values()].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    for (const symbol of card.symbols) allSymbols.push(symbol);
  }
  for (const symbol of allSymbols) {
    const list = symbolsByName.get(symbol.name);
    if (list === undefined) symbolsByName.set(symbol.name, [symbol]);
    else list.push(symbol);
  }
  const symbolsByQualifiedName = new Map<string, Map<string, OsnovaSymbol[]>>();
  for (const [file, card] of files) {
    const byName = new Map<string, OsnovaSymbol[]>();
    for (const symbol of card.symbols) {
      const list = byName.get(symbol.qualifiedName);
      if (list === undefined) byName.set(symbol.qualifiedName, [symbol]);
      else list.push(symbol);
    }
    symbolsByQualifiedName.set(file, byName);
  }
  const declaredAs = (file: string, qualifiedName: string): readonly OsnovaSymbol[] => symbolsByQualifiedName.get(file)?.get(qualifiedName) ?? [];

  const knownFiles = new Set(files.keys());
  const context = workspaceContext(files);
  const externalInput = { lockfiles: context.lockfiles, workspacePackages: new Set(context.packages.keys()), pythonRoots: context.pythonRoots, goModules: new Set(context.goModules.keys()), cargoPackages: new Set(context.cargoPackages.keys()), cargoDependencies: context.cargoDependencies, knownFiles };
  const unresolvedImport = (language: CardLanguage, fromFile: string, spec: string): Extract<EdgeResolution, { status: "unresolved" }> => {
    const external = externalLabel(language, fromFile, spec, externalInput);
    return external === undefined ? { status: "unresolved", reason: "import-target-unresolved" } : { status: "unresolved", reason: "import-target-unresolved", external };
  };
  interface ExportResult {
    symbols: Map<string, OsnovaSymbol>;
    routes: Map<string, readonly ExportHop[]>;
    namespaces: Array<{ file: string; via: readonly ExportHop[] }>;
    incomplete: boolean;
    cycle: boolean;
  }
  // A TypeScript declaration can merge a type and a value under one name. Both are exported, so the
  // export map keys on kind as well: keyed on the qualified name alone, whichever came first would
  // hide the other, and a call to the value would find only the type.
  const exportKey = (symbol: OsnovaSymbol): string => `${symbol.qualifiedName}\u0000${symbol.kind}`;
  const exportCache = new Map<string, ExportResult>();
  const exported = (file: string, name: string): ExportResult => {
    const key = JSON.stringify([file, name]);
    const cached = exportCache.get(key);
    if (cached !== undefined) return cached;
    const result: ExportResult = { symbols: new Map(), routes: new Map(), namespaces: [], incomplete: false, cycle: false };
    const visited = new Set<string>();
    const active = new Set<string>();
    const family = languageFamily(files.get(file)?.language);
    const walk = (currentFile: string, currentName: string, via: readonly ExportHop[]): void => {
      const state = JSON.stringify([currentFile, currentName]);
      if (active.has(state)) { result.cycle = true; return; }
      if (visited.has(state)) return;
      if (visited.size >= 4096 || via.length > 128) { result.incomplete = true; return; }
      visited.add(state);
      const card = files.get(currentFile);
      if (card === undefined || languageFamily(card.language) !== family) { result.incomplete = true; return; }
      if (card.language === "go") {
        const dir = path.posix.dirname(currentFile);
        const pkg = goPackageOf(card);
        for (const [file, other] of files) {
          if (other.language !== "go" || path.posix.dirname(file) !== dir || goPackageOf(other) !== pkg) continue;
          for (const symbol of other.symbols) if (symbol.name === currentName && !symbol.qualifiedName.slice(symbol.qualifiedName.indexOf("#") + 1).includes(".")) result.symbols.set(exportKey(symbol), symbol);
        }
        return;
      }
      const links = card.reExports ?? [];
      if (links.some((link) => link.kind === "blocked" && (link.exportedName === currentName || link.exportedName === "*"))) {
        result.incomplete = true;
        return;
      }
      const direct = card.symbols.filter((symbol) => symbol.exportedNames?.includes(currentName) ||
        (TYPED_FAMILY.has(card.language) && symbol.name === currentName && !symbol.qualifiedName.slice(symbol.qualifiedName.indexOf("#") + 1).includes(".")));
      const spaces = links.filter((link) => link.kind === "namespace" && link.exportedName === currentName);
      for (const link of spaces) {
        if (link.kind !== "namespace") continue;
        const target = resolveImportTarget(card.language, currentFile, link.source, knownFiles, context);
        if (target === undefined) { result.incomplete = true; continue; }
        result.namespaces.push({ file: target, via: [...via, { file: currentFile, line: link.line, kind: "namespace", exportedName: currentName, importedName: "*", source: link.source, targetFile: target }] });
      }
      const named = links.filter((link) => link.kind === "named" && link.exportedName === currentName);
      const next = direct.length > 0 || named.length > 0 || spaces.length > 0 ? named
        : currentName === "default" ? [] : links.filter((link) => link.kind === "star");
      for (const symbol of direct) {
        if (!result.symbols.has(exportKey(symbol))) {
          result.symbols.set(exportKey(symbol), symbol);
          if (!result.routes.has(symbol.qualifiedName)) result.routes.set(symbol.qualifiedName, via);
        }
      }
      active.add(state);
      for (const link of next) {
        if (link.kind === "blocked" || link.kind === "namespace") continue;
        const target = resolveImportTarget(card.language, currentFile, link.source, knownFiles, context);
        if (target === undefined) { result.incomplete = true; continue; }
        const importedName = link.kind === "named" ? link.importedName : currentName;
        walk(target, importedName, [...via, {
          file: currentFile, line: link.line, kind: link.kind, exportedName: currentName,
          importedName, source: link.source, targetFile: target,
        }]);
      }
      active.delete(state);
    };
    walk(file, name, []);
    exportCache.set(key, result);
    return result;
  };
  // Declaration files are not parsed, but a name they declare at the top level or inside
  // `declare global` is not a missing global either. Comments and strings are blanked first;
  // a `declare module "x"` body is skipped because its names are not global.
  const ambientGlobals = new Set<string>();
  const ambientNamesOf = (text: string): string[] => {
    const blank = (match: string): string => match.replace(/[^\n]/g, " ");
    const stripped = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, blank);
    const top: string[] = []; const global: string[] = [];
    const pattern = /\bdeclare\s+global\s*\{|\bdeclare\s+module\s+"[^"]*"\s*\{|\bdeclare\s+(?:function|const|let|var|class|enum|namespace|module)\s+([A-Za-z_$][\w$]*)|\b(?:function|const|let|var|class|enum|interface|type)\s+([A-Za-z_$][\w$]*)|\bimport\b(?!\s*\()|\bexport\b|[{}]/g;
    let depth = 0; let globalDepth = -1; let moduleDepth = -1; let isModule = false;
    for (const match of stripped.matchAll(pattern)) {
      const token = match[0];
      if (token === "{") { depth += 1; continue; }
      if (token === "}") { depth -= 1; if (depth <= globalDepth) globalDepth = -1; if (depth <= moduleDepth) moduleDepth = -1; continue; }
      if (token === "import" || token === "export") { if (depth === 0) isModule = true; continue; }
      if (token.startsWith("declare") && token.endsWith("{")) { if (depth === 0) { if (/global/.test(token)) globalDepth = depth; else moduleDepth = depth; } depth += 1; continue; }
      const name = match[1] ?? match[2];
      if (name === undefined || moduleDepth >= 0) continue;
      if (depth === 0 && match[1] !== undefined) top.push(name);
      else if (globalDepth >= 0 && depth === globalDepth + 1) global.push(name);
    }
    return isModule ? global : [...top, ...global];
  };
  for (const [file, card] of files) {
    if (file.endsWith(".d.ts")) for (const name of ambientNamesOf(card.text)) ambientGlobals.add(name);
  }
  const importTargetsByFile = new Map<string, string[]>();
  for (const fromFile of [...rawEdges.keys()].sort()) {
    if (reuse !== undefined && !reuse.resolve.has(fromFile)) continue;
    const raws = rawEdges.get(fromFile);
    const card = files.get(fromFile);
    if (raws === undefined || card === undefined) continue;
    const targets: string[] = [];
    for (const raw of raws) {
      if (raw.kind !== "imports") continue;
      const target = resolveImportTarget(card.language, fromFile, raw.toName, knownFiles, context);
      if (target !== undefined) targets.push(target);
    }
    if (targets.length > 0) importTargetsByFile.set(fromFile, targets);
  }

  // Declarations sharing a holder's qualified name (overloads, merged declarations) in its file.
  const declarationsOf = (holder: OsnovaSymbol): OsnovaSymbol[] => declaredAs(holder.file, holder.qualifiedName).filter(isHolder);
  const basesOf = (holder: OsnovaSymbol, base: SymbolBinding): OsnovaSymbol[] | null => {
    const holderCard = files.get(holder.file);
    if (holderCard === undefined) return null;
    let bases: readonly OsnovaSymbol[] = [];
    if (base.kind === "local") bases = declaredAs(holder.file, qualifiedNameOf(holder.file, base.name));
    else {
      const target = resolveImportTarget(holderCard.language, holder.file, base.source, knownFiles, context);
      if (target === undefined) return null;
      const found = exported(target, base.importedName);
      if (found.incomplete) return null;
      bases = [...found.symbols.values()];
    }
    const holders = bases.filter(isHolder);
    return holders.length === 0 || new Set(holders.map((symbol) => symbol.qualifiedName)).size !== 1 ? null : [holders[0]!];
  };
  const symbolsFor = (file: string, ref: SymbolBinding): OsnovaSymbol[] | null => {
    const holderCard = files.get(file);
    if (holderCard === undefined) return null;
    if (ref.kind === "local") {
      const local = [...declaredAs(file, qualifiedNameOf(file, ref.name))];
      if (local.length > 0 || !TYPED_FAMILY.has(holderCard.language)) return local;
      const family = languageFamily(holderCard.language);
      return (symbolsByName.get(ref.name) ?? []).filter((symbol) => (isHolder(symbol) || symbol.kind === "function") && languageFamily(files.get(symbol.file)?.language) === family);
    }
    const target = resolveImportTarget(holderCard.language, file, ref.source, knownFiles, context);
    if (target === undefined) return null;
    const found = exported(target, ref.importedName);
    return found.incomplete ? null : [...found.symbols.values()];
  };
  const unique = (symbols: OsnovaSymbol[] | null): OsnovaSymbol | undefined =>
    symbols !== null && symbols.length > 0 && new Set(symbols.map((symbol) => symbol.qualifiedName)).size === 1 ? symbols[0] : undefined;

  const edges: OsnovaEdge[] = [];
  for (const fromFile of [...rawEdges.keys()].sort()) {
    if (reusable !== undefined && reuse !== undefined && !reuse.resolve.has(fromFile)) {
      for (const edge of reusable.get(fromFile) ?? []) edges.push(edge);
      continue;
    }
    const raws = rawEdges.get(fromFile);
    const card = files.get(fromFile);
    if (raws === undefined || card === undefined) continue;
    const importTargets = importTargetsByFile.get(fromFile) ?? [];
    for (const raw of raws) {
      const fromSymbol = raw.enclosing.length > 0 ? qualifiedNameOf(fromFile, raw.enclosing) : "";
      if (raw.kind === "imports") {
        const toFile = resolveImportTarget(card.language, fromFile, raw.toName, knownFiles, context);
        edges.push(
          toFile === undefined
            ? { kind: "imports", fromFile, fromSymbol, toName: raw.toName, line: raw.line,
                evidence: { source: "syntax", resolution: unresolvedImport(card.language, fromFile, raw.toName) } }
            : { kind: "imports", fromFile, fromSymbol, toName: raw.toName, line: raw.line, toFile,
                evidence: { source: "syntax", resolution: { status: "resolved", method: "import-path" } } },
        );
        continue;
      }
      if (raw.binding !== undefined) {
        const binding = raw.binding;
        const reference = binding.kind === "member" ? binding.owner : binding;
        let candidates: readonly OsnovaSymbol[] = [];
        let resolution: EdgeResolution = { status: "unresolved", reason: binding.kind === "instance" || (binding.kind === "blocked" && binding.reason === "unknown-receiver") ? "receiver-unresolved"
          : binding.kind === "blocked" && binding.reason === "unbound" && !(languageFamily(card.language) === languageFamily("typescript") && ambientGlobals.has(raw.toName)) ? "unbound-global" : "binding-blocked" };
        let exportResult: ExportResult | undefined;
        if (reference.kind === "import") {
          const target = resolveImportTarget(card.language, fromFile, reference.source, knownFiles, context);
          if (target === undefined) resolution = unresolvedImport(card.language, fromFile, reference.source);
          else {
            exportResult = exported(target, reference.importedName);
            if (exportResult.incomplete) resolution = { status: "unresolved", reason: "re-export-incomplete" };
            else {
              candidates = [...exportResult.symbols.values()].filter((symbol) =>
                languageFamily(files.get(symbol.file)?.language) === languageFamily(card.language) &&
                (raw.kind !== "calls" || binding.kind === "member" || (symbol.kind !== "interface" && symbol.kind !== "type")));
              resolution = candidates.length === 0 && exportResult.cycle
                ? { status: "unresolved", reason: "re-export-cycle" }
                : { status: "resolved", method: "import-binding" };
            }
          }
        } else if (reference.kind === "local") {
          candidates = [...declaredAs(fromFile, qualifiedNameOf(fromFile, reference.name))];
          // A same-file function named like a builtin (`export function string()`) is not the type a receiver carries.
          if (binding.kind === "member" && BUILTIN_TYPES.has(reference.name) && !candidates.some(isHolder)) candidates = [];
          resolution = { status: "resolved", method: "lexical-definition" };
          if (candidates.length === 0 && binding.kind === "member") {
            const family = languageFamily(card.language);
            const holders = (symbolsByName.get(reference.name) ?? []).filter((symbol) => isHolder(symbol) && languageFamily(files.get(symbol.file)?.language) === family);
            // Languages without import bindings for types may take the single declaration of that name in the family.
            if (TYPED_FAMILY.has(card.language) && new Set(holders.map((symbol) => symbol.qualifiedName)).size === 1) { candidates = holders; resolution = { status: "resolved", method: "unique-name" }; }
            // A type no indexed file declares is a builtin or a dependency type: external, like an unbound global.
            // A language builtin stays external when the only same-named symbols are not holders (zod's `string()`
            // factory does not make a `string`-typed receiver resolvable).
            else if (holders.length === 0 && (BUILTIN_TYPES.has(reference.name) || !(symbolsByName.get(reference.name) ?? []).some((symbol) => languageFamily(files.get(symbol.file)?.language) === family))) resolution = { status: "unresolved", reason: "unbound-global" };
          }
        }
        let owner: OsnovaSymbol | undefined;
        let namespaceVia: readonly ExportHop[] | undefined;
        const namespaceTargets = exportResult === undefined ? [] : [...new Map(exportResult.namespaces.map((space) => [space.file, space])).values()];
        if (binding.kind === "member" && exportResult !== undefined && !exportResult.incomplete && namespaceTargets.length > 1 &&
          !candidates.some((symbol) => symbol.kind === "class")) {
          resolution = { status: "unresolved", reason: "binding-blocked" };
          candidates = [];
        } else if (binding.kind === "member" && exportResult !== undefined && !exportResult.incomplete && namespaceTargets.length === 1 &&
          !candidates.some((symbol) => symbol.kind === "class")) {
          const gathered: OsnovaSymbol[] = [];
          const routes = new Map<string, readonly ExportHop[]>();
          let incomplete = false, cycle = false;
          for (const space of namespaceTargets) {
            const nested = exported(space.file, binding.member);
            if (nested.incomplete) { incomplete = true; continue; }
            if (nested.cycle) cycle = true;
            for (const symbol of nested.symbols.values()) {
              if (!routes.has(symbol.qualifiedName)) routes.set(symbol.qualifiedName, [...space.via, ...(nested.routes.get(symbol.qualifiedName) ?? [])]);
              gathered.push(symbol);
            }
          }
          candidates = incomplete ? [] : gathered.filter((symbol) =>
            languageFamily(files.get(symbol.file)?.language) === languageFamily(card.language) &&
            (raw.kind !== "calls" || binding.kind === "member" || (symbol.kind !== "interface" && symbol.kind !== "type")));
          resolution = incomplete ? { status: "unresolved", reason: "re-export-incomplete" }
            : candidates.length === 0 && cycle ? { status: "unresolved", reason: "re-export-cycle" } : { status: "resolved", method: "import-binding" };
          const first = candidates[0];
          namespaceVia = first === undefined ? undefined : routes.get(first.qualifiedName);
        } else if (binding.kind === "member") {
          let basis: ReceiverBasis = binding.basis;
          const owners = candidates.filter(isHolder);
          owner = new Set(owners.map((symbol) => symbol.qualifiedName)).size === 1 ? owners[0] : undefined;
          const membersOf = (holder: OsnovaSymbol, member: string = binding.member): OsnovaSymbol[] => {
            const callableKinds: readonly string[] = holder.kind === "module"
              ? ["method", "function", "constant"]
              : ["method", "function"];
            const own = declaredAs(holder.file, `${holder.qualifiedName}.${member}`).filter((symbol) => callableKinds.includes(symbol.kind));
            if (own.length > 0 || !TYPED_FAMILY.has(card.language)) return own;
            // Go methods and Rust impl blocks may sit in another file of the same package or crate.
            const family = languageFamily(card.language);
            const holderDir = path.posix.dirname(holder.file);
            const local = `${holder.qualifiedName.slice(holder.qualifiedName.indexOf("#") + 1)}.${member}`;
            return (symbolsByName.get(member) ?? []).filter((symbol) => symbol.kind === "method" && languageFamily(files.get(symbol.file)?.language) === family &&
              symbol.qualifiedName.slice(symbol.qualifiedName.indexOf("#") + 1) === local && (card.language !== "go" || (path.posix.dirname(symbol.file) === holderDir && goPackageOf(files.get(symbol.file)!) === goPackageOf(files.get(holder.file)!))));
          };
          // Walk declared heritage when the owner itself lacks the member. Any base that cannot be
          // identified, a cycle, an own non-method field of that name, or two base chains that
          // disagree leaves the member unresolved rather than guessed.
          const inherited = (holder: OsnovaSymbol, depth: number, visited: ReadonlySet<string>, member: string = binding.member): OsnovaSymbol[] | null => {
            const declarations = declarationsOf(holder);
            if (declarations.some((declaration) => declaration.fields?.includes(member))) return null;
            const own = membersOf(holder, member);
            if (own.length > 0) return own;
            const heritage = declarations.flatMap((declaration) => declaration.heritage ?? []);
            if (heritage.length === 0) return [];
            if (depth >= 8) return null;
            let result: OsnovaSymbol[] = [];
            for (const base of heritage) {
              const targets = basesOf(holder, base);
              const target = targets?.[0];
              if (target === undefined || visited.has(target.qualifiedName)) return null;
              const found = inherited(target, depth + 1, new Set([...visited, target.qualifiedName]), member);
              if (found === null) return null;
              if (found.length === 0) continue;
              if (result.length > 0 && result[0]!.qualifiedName !== found[0]!.qualifiedName) return null;
              result = found;
            }
            return result;
          };
          // Every declaration sharing the qualified name (overloads) must agree on the return binding.
          const holderOfCallables = (found: OsnovaSymbol[] | null, receiver: OsnovaSymbol | undefined, mode: ReceiverMode | undefined, select: number | "returns" | "unwrapped" | "elements" | "values" = "returns"): OsnovaSymbol | undefined => {
            if (found === null || found.length === 0) return undefined;
            // An export lookup keeps one symbol per qualified name; every overload declaration must still agree.
            const callables = [...new Map(found.map((symbol) => [symbol.qualifiedName, symbol])).values()].flatMap((symbol) =>
              declaredAs(symbol.file, symbol.qualifiedName).filter((other) => other.kind === symbol.kind));
            const first = callables[0]!;
            if (callables.some((symbol) => symbol.qualifiedName !== first.qualifiedName)) return undefined;
            if (first.kind === "class" || first.kind === "interface") return card.language === "python" && receiver === undefined ? first : undefined;
            if (first.kind !== "function" && first.kind !== "method") return undefined;
            const returnOf = (symbol: OsnovaSymbol): ReturnBinding | null | undefined => typeof select === "number" ? symbol.returnTuple?.[select] : symbol[select];
            if (callables.some((symbol) => returnOf(symbol) === undefined || returnOf(symbol) === null || JSON.stringify(returnOf(symbol)) !== JSON.stringify(returnOf(first)))) return undefined;
            if (first.kind === "method") {
              if (callables.some((symbol) => symbol.memberKind === undefined || symbol.memberKind === "property" || symbol.memberKind === "unknown")) return undefined;
              if (card.language !== "python" && mode !== undefined && callables.some((symbol) => (mode === "class" ? symbol.memberKind !== "static" : symbol.memberKind !== "instance"))) return undefined;
            }
            const returns = returnOf(first);
            if (returns === undefined || returns === null) return undefined;
            if (returns.kind === "this") return receiver;
            return unique(symbolsFor(first.file, returns)?.filter(isHolder) ?? null);
          };
          // The declared type of a field, own declarations first, then the single-base heritage walk.
          const fieldTypeOf = (holder: OsnovaSymbol, member: string, depth: number, visited: Set<string>, table: "fieldTypes" | "elementTypes" | "valueTypes" = "fieldTypes"): { file: string; binding: SymbolBinding } | undefined => {
            const declarations = declarationsOf(holder);
            const own = declarations.flatMap((declaration) => { const binding = declaration[table]?.[member]; return binding === undefined ? [] : [{ file: declaration.file, binding }]; });
            if (own.length > 0) return new Set(own.map((item) => JSON.stringify(item))).size === 1 ? own[0] : undefined;
            if (declarations.some((declaration) => declaration.fields?.includes(member)) || depth >= 8) return undefined;
            let result: { file: string; binding: SymbolBinding } | undefined;
            for (const base of declarations.flatMap((declaration) => declaration.heritage ?? [])) {
              const target = basesOf(holder, base)?.[0];
              if (target === undefined || visited.has(target.qualifiedName)) return undefined;
              const found = fieldTypeOf(target, member, depth + 1, new Set([...visited, target.qualifiedName]), table);
              if (found === undefined) continue;
              if (result !== undefined && JSON.stringify(result) !== JSON.stringify(found)) return undefined;
              result = found;
            }
            return result;
          };
          const namespaceFilesOf = (ref: ReceiverOwner): string[] => {
            if (ref.kind !== "import") return [];
            const target = resolveImportTarget(card.language, fromFile, ref.source, knownFiles, context);
            if (target === undefined) return [];
            if (ref.importedName === "*") return [target];
            const found = exported(target, ref.importedName);
            return found.incomplete ? [] : [...new Set(found.namespaces.map((space) => space.file))];
          };
          const selectOf = (ref: { index?: number | undefined; unwrapped?: true | undefined }, elements = false): number | "returns" | "unwrapped" | "elements" | "values" =>
            elements ? "elements" : ref.unwrapped === true ? "unwrapped" : ref.index === undefined ? "returns" : ref.index;
          // `const create = Thing.make` is a callable under another name. The alias is recorded where the
          // constant is declared, so its owner resolves against that file rather than the calling one.
          const aliasCallablesOf = (symbol: OsnovaSymbol, depth: number): { callables: OsnovaSymbol[]; mode: ReceiverMode | undefined } | undefined => {
            const alias = symbol.aliasOf;
            if (alias === undefined || depth > 4) return undefined;
            if (alias.kind === "local" || alias.kind === "import") {
              const found = symbolsFor(symbol.file, alias) ?? [];
              return found.length === 0 ? undefined : { callables: found, mode: undefined };
            }
            if (alias.owner.kind !== "local" && alias.owner.kind !== "import") return undefined;
            const holder = unique(symbolsFor(symbol.file, alias.owner)?.filter(isHolder) ?? null);
            if (holder === undefined) return undefined;
            const found = inherited(holder, 0, new Set([holder.qualifiedName]), alias.member);
            return found === null || found.length === 0 ? undefined : { callables: found, mode: alias.mode };
          };
          // The callables a return owner names: a bound function, or a member of a holder or namespace.
          const callablesOf = (of: Callee, depth: number): { callables: OsnovaSymbol[] | null; holder: OsnovaSymbol | undefined; mode: ReceiverMode | undefined } | undefined => {
            if (of.kind === "local" || of.kind === "import") {
              const callable = (symbol: OsnovaSymbol): boolean => isHolder(symbol) || symbol.kind === "function" || symbol.kind === "method";
              const found = symbolsFor(fromFile, of);
              const direct = found?.filter(callable) ?? null;
              if (direct !== null && direct.length === 0 && found?.length === 1) {
                const aliased = aliasCallablesOf(found[0]!, depth);
                if (aliased !== undefined) return { callables: aliased.callables.filter(callable), holder: undefined, mode: aliased.mode };
              }
              return { callables: direct, holder: undefined, mode: undefined };
            }
            const holder = holderOf(of.owner, depth + 1);
            if (holder === undefined) {
              const spaces = namespaceFilesOf(of.owner);
              if (spaces.length !== 1) return undefined;
              const found = exported(spaces[0]!, of.member);
              return found.incomplete ? undefined : { callables: [...found.symbols.values()].filter((symbol) => symbol.kind === "function" || symbol.kind === "method"), holder: undefined, mode: undefined };
            }
            return { callables: inherited(holder, 0, new Set([holder.qualifiedName]), of.member), holder, mode: of.mode };
          };
          // Builtin collections have no indexed holder: `xs.filter(..)` keeps the element type, `map.values()`
          // yields the value or element type, and `map.get(k)` produces the value type.
          const PASS_THROUGH = new Set(["filter", "slice", "concat", "reverse", "sort", "toSorted", "toReversed", "values", "iter", "iter_mut", "into_iter", "cloned", "copied", "stream", "sorted", "distinct", "Where", "OrderBy", "OrderByDescending", "ThenBy", "Distinct", "ToList", "ToArray", "AsEnumerable", "Skip", "Take", "Reverse", "ToImmutableArray", "ToImmutableList"]);
          // Why a receiver chain stopped: it ended on a type no indexed file declares (external, like an
          // unbound global) or on an import the index cannot follow. Unknown otherwise.
          type Terminal = "external" | { readonly file: string; readonly source: string } | undefined;
          const terminalOfBinding = (file: string, binding: SymbolBinding): Terminal => {
            const holderCard = files.get(file);
            if (holderCard === undefined) return undefined;
            if (binding.kind === "import") return resolveImportTarget(holderCard.language, file, binding.source, knownFiles, context) === undefined ? { file, source: binding.source } : undefined;
            const family = languageFamily(holderCard.language);
            if ((symbolsFor(file, binding) ?? []).length > 0) return undefined;
            const name = binding.name.split(".").pop() ?? binding.name;
            return (symbolsByName.get(name) ?? []).some((symbol) => languageFamily(files.get(symbol.file)?.language) === family) ? undefined : "external";
          };
          const terminalOf = (ref: ReceiverOwner, depth: number): Terminal => {
            if (depth > 6) return undefined;
            if (ref.kind === "local" || ref.kind === "import") return terminalOfBinding(fromFile, ref);
            if (ref.kind === "super") return undefined;
            if (ref.kind === "field" || (ref.kind === "element" && ref.of.kind === "field")) {
              const inner = ref.kind === "field" ? ref : ref.of as Extract<ReceiverOwner, { kind: "field" }>;
              const holder = holderOf(inner.of, depth + 1);
              if (holder === undefined) return terminalOf(inner.of, depth + 1);
              const tables: Array<"fieldTypes" | "elementTypes" | "valueTypes"> = ref.kind === "field" ? ["fieldTypes"] : ref.mode === "value" ? ["valueTypes"] : ref.mode === "either" ? ["valueTypes", "elementTypes"] : ["elementTypes"];
              for (const table of tables) { const typed = fieldTypeOf(holder, inner.member, 0, new Set([holder.qualifiedName]), table); if (typed !== undefined) return terminalOfBinding(typed.file, typed.binding); }
              return undefined;
            }
            const inner = ref.kind === "element" ? ref.of : ref;
            if (inner.kind !== "return") return undefined;
            const found = callablesOf(inner.of, depth);
            if (found === undefined || found.callables === null || found.callables.length === 0) return inner.of.kind === "method" ? terminalOf(inner.of.owner, depth + 1) : inner.of.kind === "import" || inner.of.kind === "local" ? terminalOfBinding(fromFile, inner.of) : undefined;
            const first = found.callables[0]!;
            const select = ref.kind === "element" ? (ref.mode === "value" ? "values" : "elements") : selectOf(inner);
            const returned = typeof select === "number" ? first.returnTuple?.[select] : first[select];
            return returned === undefined || returned === null || returned.kind === "this" ? undefined : terminalOfBinding(first.file, returned);
          };
          const holderOf = (ref: ReceiverOwner, depth: number): OsnovaSymbol | undefined => {
            if (depth > 6) return undefined;
            if (ref.kind === "element") {
              // The element (or value) of a collection: a field's or a return type's recorded element type.
              const inner = ref.of;
              const tables: Array<"elementTypes" | "valueTypes"> = ref.mode === "value" ? ["valueTypes"] : ref.mode === "either" ? ["valueTypes", "elementTypes"] : ["elementTypes"];
              const selects: Array<"elements" | "values"> = ref.mode === "value" ? ["values"] : ref.mode === "either" ? ["values", "elements"] : ["elements"];
              if (inner.kind === "field") {
                const holder = holderOf(inner.of, depth + 1);
                if (holder === undefined) return undefined;
                for (const table of tables) {
                  const typed = fieldTypeOf(holder, inner.member, 0, new Set([holder.qualifiedName]), table);
                  if (typed !== undefined) return unique(symbolsFor(typed.file, typed.binding)?.filter(isHolder) ?? null);
                }
                return undefined;
              }
              if (inner.kind !== "return" || inner.unwrapped === true || inner.index !== undefined) return undefined;
              const found = callablesOf(inner.of, depth);
              if (found !== undefined && found.callables !== null && found.callables.length > 0) {
                for (const select of selects) { const holder = holderOfCallables(found.callables, found.holder, found.mode, select); if (holder !== undefined) return holder; }
                return undefined;
              }
              if (inner.of.kind === "method" && PASS_THROUGH.has(inner.of.member)) return holderOf({ kind: "element", of: inner.of.owner, mode: inner.of.member === "values" ? "either" : ref.mode }, depth + 1);
              return undefined;
            }
            if (ref.kind === "field") {
              const holder = holderOf(ref.of, depth + 1);
              const typed = holder === undefined ? undefined : fieldTypeOf(holder, ref.member, 0, new Set([holder.qualifiedName]));
              return typed === undefined ? undefined : unique(symbolsFor(typed.file, typed.binding)?.filter(isHolder) ?? null);
            }
            if (ref.kind === "super") {
              // The parent class: exactly one declared base, resolved like the heritage walk does.
              const cls = unique(symbolsFor(fromFile, ref.of)?.filter(isHolder) ?? null);
              if (cls === undefined) return undefined;
              const heritage = declarationsOf(cls).flatMap((declaration) => declaration.heritage ?? []);
              const base = heritage[0];
              return heritage.length === 1 && base !== undefined ? basesOf(cls, base)?.[0] : undefined;
            }
            if (ref.kind !== "return") return unique(symbolsFor(fromFile, ref)?.filter(isHolder) ?? null);
            const found = callablesOf(ref.of, depth);
            if (found !== undefined && found.callables !== null && found.callables.length > 0) return holderOfCallables(found.callables, found.holder, found.mode, selectOf(ref));
            if (ref.of.kind === "method" && ref.of.member === "get" && ref.index === undefined) return holderOf({ kind: "element", of: ref.of.owner, mode: "either" }, depth + 1);
            return undefined;
          };
          const rootUnresolvedImport = (ref: ReceiverOwner | Callee, depth = 0): string | undefined => {
            if (depth > 8) return undefined;
            if (ref.kind === "import") return resolveImportTarget(card.language, fromFile, ref.source, knownFiles, context) === undefined ? ref.source : undefined;
            if (ref.kind === "return") return rootUnresolvedImport(ref.of, depth + 1);
            if (ref.kind === "super") return undefined;
            if (ref.kind === "field" || ref.kind === "element") return rootUnresolvedImport(ref.of, depth + 1);
            if (ref.kind === "method") return rootUnresolvedImport(ref.owner, depth + 1);
            return undefined;
          };
          if (binding.owner.kind === "return") {
            owner = holderOf(binding.owner, 0); basis = "return";
          } else if (binding.owner.kind === "super") {
            owner = holderOf(binding.owner, 0);
          } else if (binding.owner.kind === "field" || binding.owner.kind === "element") {
            owner = holderOf(binding.owner, 0);
          }
          if (owner === undefined && (binding.owner.kind === "return" || binding.owner.kind === "field" || binding.owner.kind === "element")) {
            const rootImport = rootUnresolvedImport(binding.owner);
            const terminal: Terminal = rootImport !== undefined ? { file: fromFile, source: rootImport } : terminalOf(binding.owner, 0);
            if (typeof terminal === "object") resolution = unresolvedImport(files.get(terminal.file)?.language ?? card.language, terminal.file, terminal.source);
            else if (terminal === "external") resolution = { status: "unresolved", reason: "unbound-global" };
          }
          else if (owner === undefined && card.language === "python" && binding.basis === "constructor") {
            owner = holderOfCallables(candidates.filter((symbol) => symbol.kind === "function" || symbol.kind === "method"), undefined, undefined);
            if (owner !== undefined) basis = "return";
          }
          const members: OsnovaSymbol[] = owner === undefined ? [] : inherited(owner, 0, new Set([owner.qualifiedName])) ?? [];
          // A namespace function behaves like a static member: reachable through the namespace name, never through an instance.
          // A namespace constant holding a function behaves like a namespace function: reachable
          // through the namespace name, never through an instance.
          const effectiveKind = (symbol: OsnovaSymbol) =>
            symbol.kind === "function" || (owner?.kind === "module" && symbol.kind === "constant") ? "static" : symbol.memberKind;
          const kinds = new Set(members.map(effectiveKind));
          candidates = kinds.size > 1 ? [] : members.filter((symbol) => {
            const kind = effectiveKind(symbol);
            if (kind === undefined || kind === "unknown" || kind === "property") return false;
            if (card.language === "python") return true;
            return binding.mode === "class" ? kind === "static" : kind === "instance";
          });
          if (owner !== undefined && candidates.length > 0) {
            resolution = { status: "resolved", method: "receiver-hint", receiver: { classSymbol: owner.qualifiedName, mode: binding.mode, basis } };
          } else if (resolution.status === "resolved" || reference.kind === "super" || (reference.kind === "local" && resolution.reason !== "unbound-global") || ((reference.kind === "return" || reference.kind === "field" || reference.kind === "element") && resolution.reason !== "import-target-unresolved" && resolution.reason !== "unbound-global")) {
            resolution = { status: "unresolved", reason: "receiver-unresolved" };
          }
        }
        if (raw.kind === "references") candidates = candidates.filter((symbol) => VALUE_REFERENCE_KINDS.has(symbol.kind));
        const names = [...new Set(candidates.map((symbol) => symbol.qualifiedName))].sort();
        const resolved = names.length === 1 ? candidates[0] : undefined;
        if (names.length > 1) resolution = { status: "ambiguous", candidates: names };
        else if (resolved === undefined && resolution.status === "resolved") resolution = { status: "unresolved", reason: "bound-symbol-missing" };
        // A value reference is recorded only when it names an indexed callable or class; a bound name that
        // reaches a constant, a type or an import the index cannot follow leaves no edge.
        if (raw.kind === "references" && resolution.status === "unresolved") continue;
        const via = resolved === undefined ? undefined : namespaceVia ?? exportResult?.routes.get(owner?.qualifiedName ?? resolved.qualifiedName);
        if (via !== undefined && via.length > 0) resolution = resolution.status === "resolved" && resolution.method === "receiver-hint"
          ? { ...resolution, via } : { status: "resolved", method: "re-export-binding", via };
        edges.push({
          kind: raw.kind, fromFile, fromSymbol, toName: raw.toName, line: raw.line, binding,
          evidence: { source: "syntax", resolution },
          ...(resolved === undefined ? {} : { toSymbol: resolved.qualifiedName, toFile: resolved.file }),
        });
        continue;
      }
      const lookupName = raw.toName.includes(".")
        ? (raw.toName.split(".").pop() ?? raw.toName)
        : raw.toName;
      // A plain Rust name never names an impl method or a variant: `Ok(x)` is the prelude's, not `ParseResult::Ok`,
      // however unique that is. A function nested in a function or method (`fn imp` inside `fn is_readable_stdin`) still counts.
      const memberOfHolder = (symbol: OsnovaSymbol): boolean => {
        const parts = symbol.qualifiedName.slice(symbol.qualifiedName.indexOf("#") + 1).split(".");
        for (let take = parts.length - 1; take > 0; take -= 1) {
          const parent = declaredAs(symbol.file, `${symbol.file}#${parts.slice(0, take).join(".")}`)[0];
          if (parent !== undefined) return isHolder(parent);
        }
        return false;
      };
      const candidates = (symbolsByName.get(lookupName) ?? []).filter((symbol) =>
        languageFamily(files.get(symbol.file)?.language) === languageFamily(card.language) &&
        (card.language !== "rust" || raw.toName.includes(".") || !memberOfHolder(symbol)));
      const sameFile = candidates.filter((symbol) => symbol.file === fromFile);
      const imported = candidates.filter((symbol) => importTargets.includes(symbol.file));
      const preferred = sameFile.length > 0 ? sameFile : imported.length > 0 ? imported : candidates;
      const names = [...new Set(preferred.map((symbol) => symbol.qualifiedName))].sort();
      const resolved = names.length === 1 ? preferred[0] : undefined;
      const resolution: EdgeResolution = names.length > 1
        ? { status: "ambiguous", candidates: names }
        // Go, Rust, Java and C# bind plain names without an import statement, so a name no indexed file of
        // the family defines is a builtin or a standard-library name: external, like an unbound global.
        : resolved === undefined ? { status: "unresolved", reason: TYPED_FAMILY.has(card.language) && candidates.length === 0 ? "unbound-global" : "no-matching-symbol" }
          : { status: "resolved", method: sameFile.length > 0 ? "same-file-name" : imported.length > 0 ? "imported-file-name" : "unique-name" };
      edges.push(
        resolved === undefined
          ? { kind: raw.kind, fromFile, fromSymbol, toName: raw.toName, line: raw.line, evidence: { source: "syntax", resolution } }
          : {
              kind: raw.kind,
              fromFile,
              fromSymbol,
              toName: raw.toName,
              line: raw.line,
              toSymbol: resolved.qualifiedName,
              toFile: resolved.file,
              evidence: { source: "syntax", resolution },
            },
      );
    }
  }
  return edges;
}
