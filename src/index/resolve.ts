import path from "node:path";
import type { Callee, CardLanguage, Construction, EdgeResolution, ExportHop, FileCard, OsnovaEdge, OsnovaSymbol, ParameterRange, ReceiverBasis, ReceiverMode, ReceiverOwner, ReturnBinding, SymbolBinding } from "../types.js";
import { localOfQualifiedName, qualifiedNameOf } from "./indexImpl.js";
import type { RawEdgeItem } from "./indexImpl.js";
import { collectLockfiles, externalLabel } from "./external.js";
import type { Lockfiles } from "./external.js";
import { TsConfigs, probeNodeFile } from "./tsconfig.js";
import { chooseByArgumentTypes } from "./java-types.js";
import type { JavaTypeWorld } from "./java-types.js";
import { DOTNET_EXTENSIONS, DOTNET_MEMBERS, DOTNET_TYPES } from "./dotnet-table.js";

const HOLDER_KINDS = new Set(["class", "interface", "module", "struct", "enum", "trait"]);
const isHolder = (symbol: OsnovaSymbol): boolean => HOLDER_KINDS.has(symbol.kind);
const VALUE_REFERENCE_KINDS: ReadonlySet<string> = new Set(["function", "method", "class"]);
// A route handler is a callable or a class; a mount target may also be a router held in a constant.
const ROUTE_TARGET_KINDS: ReadonlySet<string> = new Set(["function", "method", "class", "constant"]);
// A declared base is a type, never a value: a same-named function or constant is not the base.
const HERITAGE_KINDS: ReadonlySet<string> = new Set(["class", "interface", "struct", "trait"]);
// Languages whose receiver hints name a type without an import binding; a type not declared in the
// file may still be the single declaration of that name in the same language family.
const TYPED_FAMILY = new Set(["go", "rust", "java", "c_sharp"]);
// Builtin type names a receiver annotation or literal can carry: never a holder the index could define.
const BUILTIN_TYPES = new Set(["string", "number", "boolean", "bigint", "symbol", "Array", "Map", "Set", "WeakMap", "WeakSet", "Promise", "RegExp", "Date", "Error", "Object", "Function", "str", "list", "dict", "set", "tuple", "int", "float", "bool", "bytes"]);
const goHeaders = new WeakMap<FileCard, { readonly name: string; readonly constrained: boolean }>();
// File-name suffixes that build a Go file only for one operating system or architecture (`_windows.go`, `_linux_arm64_test.go`).
const GO_TARGET_SUFFIX = /_(aix|android|darwin|dragonfly|freebsd|hurd|illumos|ios|js|linux|nacl|netbsd|openbsd|plan9|solaris|wasip1|windows|zos|386|amd64|amd64p32|arm|arm64|arm64be|armbe|loong64|mips|mips64|mips64le|mips64p32|mips64p32le|mipsle|ppc|ppc64|ppc64le|riscv|riscv64|s390|s390x|sparc|sparc64|wasm)(_test)?\.go$/u;
const javaPackages = new WeakMap<FileCard, string>();
export function parsedWithoutErrors(card: FileCard | undefined): boolean {
  return !(card?.diagnostics ?? []).some((diagnostic) => diagnostic.code === "syntax-errors") && !unread(card);
}

// A file whose extraction failed or parsed to nothing: it may declare anything, which the resolver treats apart from a
// file with syntax errors.
export function unread(card: FileCard | undefined): boolean {
  return (card?.diagnostics ?? []).some((diagnostic) => diagnostic.code === "extraction-failed" || diagnostic.code === "empty-parse");
}

export function javaPackageOf(card: FileCard | undefined): string {
  if (card === undefined) return "";
  const cached = javaPackages.get(card);
  if (cached !== undefined) return cached;
  const name = card.language === "java" ? card.text.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1] ?? "" : "";
  javaPackages.set(card, name);
  return name;
}
// The package clause, read past the comments before it, separates an external _test package from the production package
// in one directory. A `//go:build` or `// +build` comment before the clause, or a target file-name suffix, builds the file
// only in some configurations.
function goHeaderOf(card: FileCard): { readonly name: string; readonly constrained: boolean } {
  const cached = goHeaders.get(card);
  if (cached !== undefined) return cached;
  const text = card.text;
  let at = 0;
  let constrained = GO_TARGET_SUFFIX.test(card.path);
  for (;;) {
    while (at < text.length && /\s/u.test(text[at]!)) at += 1;
    if (text.startsWith("//", at)) {
      const end = text.indexOf("\n", at);
      const line = text.slice(at, end < 0 ? text.length : end);
      if (/^\/\/(go:build\s|\s*\+build\s)/u.test(line)) constrained = true;
      at = end < 0 ? text.length : end + 1;
    } else if (text.startsWith("/*", at)) {
      const end = text.indexOf("*/", at + 2);
      at = end < 0 ? text.length : end + 2;
    } else break;
  }
  // `package`, then the name after any whitespace or comments; a Go identifier is letters (any script), digits and `_`.
  let name = "";
  if (/^package(?![\p{L}\p{Nd}_])/u.test(text.slice(at))) {
    at += "package".length;
    for (;;) {
      while (at < text.length && /\s/u.test(text[at]!)) at += 1;
      if (text.startsWith("/*", at)) {
        const end = text.indexOf("*/", at + 2);
        at = end < 0 ? text.length : end + 2;
      } else break;
    }
    name = /^[\p{L}_][\p{L}\p{Nd}_]*/u.exec(text.slice(at))?.[0] ?? "";
  }
  const header = { name, constrained };
  goHeaders.set(card, header);
  return header;
}
// Whether two Go files declare one package: an unread clause matches nothing, not another unread clause.
function sameGoPackage(a: FileCard, b: FileCard): boolean {
  const name = goHeaderOf(a).name;
  return name !== "" && name === goHeaderOf(b).name;
}

export function languageFamily(language: CardLanguage | undefined): string | undefined {
  if (language === "typescript" || language === "tsx" || language === "javascript") return "javascript";
  if (language === "c" || language === "cpp" || language === "objc") return "c";
  if (language === "java" || language === "kotlin" || language === "scala") return "java";
  return language;
}

function resolveNodeSpecifier(
  fromFile: string,
  spec: string,
  knownFiles: ReadonlySet<string>,
): string | undefined {
  return probeNodeFile(path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec)), knownFiles);
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
  /** tsconfig.json and jsconfig.json `paths` and `baseUrl`, read from the nearest config above the importing file. */
  readonly tsConfigs: TsConfigs;
  /** Qualified names of Rust inline modules (`src/main.rs#m.inner`), which a path walks before any module file. */
  readonly rustInlineModules: ReadonlySet<string>;
  /** Per Rust file, the `mod name;` declarations it writes at its top level: `file`, or `path` when an attribute
   * sets its path; `nested` for one written only inside an inline module. */
  readonly rustModuleFiles: ReadonlyMap<string, ReadonlyMap<string, "file" | "path" | "nested">>;
  /** Rust crate roots a Cargo.toml target section names with `path = ".."`. */
  readonly rustTargetRoots: ReadonlySet<string>;
  /** Rust module file to the files whose top-level `mod name;` declares it. */
  readonly rustDeclaredBy: ReadonlyMap<string, readonly string[]>;
  /** Rust files a declaration may name that the scan could not follow: no root, and no module the walk enters. */
  readonly rustUncertainOwner: ReadonlySet<string>;
  /** Some `#[path]` value or delimiter could not be read, so any file may be a module: no crate root is proven. */
  readonly rustOwnershipUnreadable: boolean;
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
  // Which file owns each Rust module file. A declaration the scan can follow (`mod name;` at the top level, in a
  // named inline module, or with a literal `#[path]`) links its file to the declaring file. One it can see but not
  // follow (inside a macro or function body, or a `cfg_attr` path) marks its candidate files as owned by an
  // unknown declarer, so they are neither a root nor a module the walk may enter. A `path` value that cannot be
  // read could name any file, and leaves every crate root unproven.
  const rustScans = new Map([...files.values()].filter((card) => card.language === "rust").map((card) => [card.path, scanRustModules(card.text)]));
  const rustTargetRoots = new Set([...files.values()].flatMap((card) => {
    if (path.posix.basename(card.path) !== "Cargo.toml") return [];
    const dir = path.posix.dirname(card.path) === "." ? "" : path.posix.dirname(card.path);
    return [...card.text.matchAll(/^\s*\[\[?(?:lib|bin|test|example|bench)\]\]?\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/gm)]
      .flatMap((section) => [...(section[1] ?? "").matchAll(/^\s*path\s*=\s*"([^"]+)"/gm)].map((entry) => path.posix.normalize(path.posix.join(dir, entry[1]!))));
  }));
  const rustModuleFiles = new Map<string, Map<string, "file" | "path" | "nested">>();
  const linkRust = (beside: (file: string) => boolean) => {
    const declaredBy = new Map<string, string[]>();
    const uncertain = new Set<string>();
    let unreadable = false;
    const add = (child: string, declarer: string, certain: boolean) => {
      if (!files.has(child)) return;
      if (!certain) { uncertain.add(child); return; }
      const list = declaredBy.get(child);
      if (list === undefined) declaredBy.set(child, [declarer]); else if (!list.includes(declarer)) list.push(declarer);
    };
    for (const [file, scan] of rustScans) {
      const dir = path.posix.dirname(file) === "." ? "" : path.posix.dirname(file);
      const childDir = beside(file) ? dir : path.posix.join(dir, path.posix.basename(file).replace(/\.rs$/, ""));
      if (scan.unbalanced) unreadable = true;
      for (const declaration of scan.declarations) {
        const nestedDir = path.posix.join(childDir, ...declaration.inline);
        const conventional = [path.posix.join(nestedDir, `${declaration.name}.rs`), path.posix.join(nestedDir, declaration.name, "mod.rs")];
        if (declaration.hasPath && declaration.pathValue === undefined) { unreadable = true; continue; }
        // A literal path is relative to the file's directory at the top level, and to the inline modules'
        // directory (from the module directory of the file) inside one.
        const pathTarget = declaration.pathValue === undefined ? undefined : path.posix.normalize(path.posix.join(declaration.inline.length === 0 ? dir : nestedDir, declaration.pathValue));
        if (declaration.other) {
          for (const candidate of [...conventional, ...(pathTarget === undefined ? [] : [pathTarget, path.posix.normalize(path.posix.join(dir, declaration.pathValue!))])]) add(candidate, file, false);
        } else if (pathTarget !== undefined) add(pathTarget, file, !declaration.cfgPath);
        else for (const candidate of conventional) add(candidate, file, true);
      }
    }
    return { declaredBy, uncertain, unreadable };
  };
  for (const [file, scan] of rustScans) {
    const kinds = new Map<string, "file" | "path" | "nested">();
    for (const declaration of scan.declarations) {
      // A cfg-gated module is followed only while nothing else in the file binds its name: the gate may be off,
      // and a `use .. as name` or a type of that name would then be what the path names.
      const kind = declaration.other || declaration.inline.length > 0 ? "nested" : declaration.hasPath || (declaration.cfg && rustNameBoundOtherwise(scan.code, declaration.name)) ? "path" : "file";
      const previous = kinds.get(declaration.name);
      kinds.set(declaration.name, previous === "path" || kind === "path" ? "path" : previous === "file" || kind === "file" ? "file" : "nested");
    }
    rustModuleFiles.set(file, kinds);
  }
  // A file's child modules sit beside it when it is mod.rs or a crate root, else in the directory named after it.
  // Whether it is a root depends on what declares it, so the links are built once from where roots may sit and
  // again from the roots that first pass proves.
  const firstPass = linkRust((file) => path.posix.basename(file) === "mod.rs" || rustRootPlace(file, rustTargetRoots, cargoRoots));
  const ownership = linkRust((file) => path.posix.basename(file) === "mod.rs" || (rustRootPlace(file, rustTargetRoots, cargoRoots) && !firstPass.declaredBy.has(file) && !firstPass.uncertain.has(file)));
  const rustDeclaredBy = ownership.declaredBy;
  return { packages, pythonRoots: [...pythonRoots.values()].sort((a, b) => a.manifest < b.manifest ? -1 : a.manifest > b.manifest ? 1 : a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0), goModules, cargoRoots: cargoRoots.sort(), cargoPackages, crateAliases, cargoSrc, lockfiles: collectLockfiles(files), cargoDependencies, tsConfigs: new TsConfigs(files),
    rustInlineModules: new Set([...files.values()].flatMap((card) => card.language === "rust" ? card.symbols.filter((symbol) => symbol.kind === "module").map((symbol) => symbol.qualifiedName) : [])),
    rustModuleFiles,
    rustDeclaredBy,
    rustUncertainOwner: ownership.uncertain,
    rustOwnershipUnreadable: ownership.unreadable,
    rustTargetRoots };
}

// Where a Rust crate root may sit: a Cargo target path, lib.rs or main.rs in a src directory, build.rs beside a
// Cargo.toml, a file directly under tests/, examples/, benches/ or src/bin/, or main.rs one directory below one.
function rustRootPlace(file: string, targetRoots: ReadonlySet<string>, cargoRoots: readonly string[]): boolean {
  const parentOf = (dir: string): string => path.posix.dirname(dir) === "." ? "" : path.posix.dirname(dir);
  const dir = parentOf(file);
  const name = path.posix.basename(file);
  const targetDir = (candidate: string): boolean => ["tests", "examples", "benches"].includes(path.posix.basename(candidate)) || (path.posix.basename(candidate) === "bin" && path.posix.basename(parentOf(candidate)) === "src");
  return targetRoots.has(file) || ((name === "lib.rs" || name === "main.rs") && path.posix.basename(dir) === "src") || (name === "build.rs" && cargoRoots.includes(dir))
    || targetDir(dir) || (name === "main.rs" && dir !== "" && targetDir(parentOf(dir)));
}

interface RustModuleDeclaration {
  readonly name: string;
  /** The named inline modules around it, outermost first. */
  readonly inline: readonly string[];
  /** Inside some other body (a macro, a function, an impl): the scan cannot tell where it belongs. */
  readonly other: boolean;
  readonly cfg: boolean;
  readonly hasPath: boolean;
  readonly cfgPath: boolean;
  readonly pathValue: string | undefined;
}

// The `mod name;` declarations of Rust source. Comments (block comments nest), strings, raw strings and char
// literals are blanked first; delimiter depth covers braces, parentheses and brackets, so a macro body of any
// delimiter is never the top level. `unbalanced` when the delimiters do not pair up, and nothing read is trusted.
function scanRustModules(text: string): { declarations: RustModuleDeclaration[]; unbalanced: boolean; code: string } {
  const strings: string[] = [];
  let code = "";
  for (let index = 0; index < text.length;) {
    const char = text[index]!;
    const next = text[index + 1];
    if (char === "/" && next === "/") { const end = text.indexOf("\n", index); index = end < 0 ? text.length : end; code += " "; continue; }
    if (char === "/" && next === "*") {
      let depth = 1;
      index += 2;
      while (index < text.length && depth > 0) {
        if (text[index] === "/" && text[index + 1] === "*") { depth += 1; index += 2; }
        else if (text[index] === "*" && text[index + 1] === "/") { depth -= 1; index += 2; }
        else index += 1;
      }
      code += " ";
      continue;
    }
    const raw = /^(?:b|c)?r(#*)"/.exec(text.slice(index, index + 260));
    if (raw !== null && (index === 0 || !/[\p{L}\p{N}_]/u.test(text[index - 1]!))) {
      const close = `"${raw[1]}`;
      const end = text.indexOf(close, index + raw[0].length);
      const stop = end < 0 ? text.length : end + close.length;
      strings.push(text.slice(index + raw[0].length, end < 0 ? text.length : end));
      code += ` "S${strings.length - 1}" `;
      index = stop;
      continue;
    }
    if (char === '"' || ((char === "b" || char === "c") && next === '"' && (index === 0 || !/[\p{L}\p{N}_]/u.test(text[index - 1]!)))) {
      let at = char === '"' ? index + 1 : index + 2;
      let value = "";
      let escaped = false;
      while (at < text.length && text[at] !== '"') { if (text[at] === "\\") { escaped = true; value += text.slice(at, at + 2); at += 2; } else { value += text[at]; at += 1; } }
      strings.push(escaped ? "\u0000" : value);
      code += ` "S${strings.length - 1}" `;
      index = at + 1;
      continue;
    }
    if (char === "'") {
      const literal = /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]{1,6}\}|.)|[^\\'\n])'/u.exec(text.slice(index, index + 16));
      if (literal !== null) { code += " "; index += literal[0].length; continue; }
    }
    code += char;
    index += 1;
  }
  const declarations: RustModuleDeclaration[] = [];
  const stack: (string | null)[] = [];
  let unbalanced = false;
  const pattern = /((?:#\[[^\]]*\]\s*)*)(?:pub(?:\s*\([^)]*\))?\s+)?(?:unsafe\s+)?(?<![\p{L}\p{N}_#])mod\s+(?:r#)?([\p{L}\p{N}_]+)\s*([;{])|([{}()[\]])/gu;
  for (const match of code.matchAll(pattern)) {
    const delimiter = match[4];
    if (delimiter !== undefined) {
      if (delimiter === "{" || delimiter === "(" || delimiter === "[") stack.push(null);
      else if (stack.pop() === undefined) unbalanced = true;
      continue;
    }
    const name = match[2]!;
    if (match[3] === "{") { stack.push(name); continue; }
    const attributes = match[1] ?? "";
    const value = /(?:^|[\s(,[])path\s*=\s*"S(\d+)"/.exec(attributes)?.[1];
    const pathValue = value === undefined ? undefined : strings[Number(value)];
    declarations.push({
      name,
      inline: stack.every((entry) => entry !== null) ? stack as string[] : [],
      other: stack.some((entry) => entry === null),
      cfg: /(?:^|[^\p{L}\p{N}_])cfg(?:_attr)?\s*\(/u.test(attributes),
      hasPath: /(?:^|[\s(,[])path\s*=/.test(attributes),
      cfgPath: /(?:^|[^\p{L}\p{N}_])cfg_attr\s*\(/u.test(attributes) && /(?:^|[\s(,[])path\s*=/.test(attributes),
      pathValue: pathValue === undefined || pathValue.includes("\u0000") ? undefined : pathValue,
    });
  }
  return { declarations, unbalanced: unbalanced || stack.length > 0, code };
}

// Whether blanked Rust code binds a name other than by `mod name;`: as the last name or the alias of a `use` or
// `extern crate`, or as a type, trait, inline module or macro-free item of the type namespace.
function rustNameBoundOtherwise(code: string, name: string): boolean {
  const id = `(?:r#)?${name}(?![\\p{L}\\p{N}_])`;
  for (const statement of code.matchAll(/(?<![\p{L}\p{N}_])(?:use|extern\s+crate)\s[^;]*;/gu)) {
    if (new RegExp(`(?:\\bas\\s+|::\\s*|[{,]\\s*|(?:use|crate)\\s+)${id}\\s*(?=[,};])`, "u").test(statement[0])) return true;
  }
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:struct|enum|union|trait|type|mod)\\s+${id}\\s*[^;\\s]`, "u").test(code);
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
    if (spec.startsWith("node:") || spec.startsWith("/")) return undefined;
    const alias = context.tsConfigs.resolve(fromFile, spec, knownFiles);
    if (alias.kind !== "none") return alias.kind === "file" ? alias.file : undefined;
    if (spec.startsWith("#")) return undefined;
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
  return resolveRustPath(fromFile, spec, knownFiles, context)?.file;
}

// The file a Rust path lands on, and the segments left after it: the inline modules of that file the path
// continues through (`use super::inner::Deep` with `mod inner { .. }` in the file gives inline ["inner"]).
function resolveRustPath(fromFile: string, spec: string, knownFiles: ReadonlySet<string>, context: WorkspaceContext): { file: string; inline: string[] } | undefined {
  const segments = spec.split("::").filter((part) => part.length > 0).map((part) => part.replace(/^r#/, ""));
  const head = segments[0];
  if (head === undefined) return undefined;
  const parentOf = (dir: string): string => path.posix.dirname(dir) === "." ? "" : path.posix.dirname(dir);
  const fromDir = parentOf(fromFile);
  const srcOf = (crate: string): string => context.cargoSrc.get(crate) ?? (crate === "" ? "src" : `${crate}/src`);
  const base = path.posix.basename(fromFile);
  // A crate root sits where Cargo looks for one (rustRootPlace) and nothing declares it as a module. A file a
  // declaration the scan could not follow may name has no known owner: it is neither, and its paths name nothing.
  // Its child modules live beside it, as a mod.rs file's do.
  if (context.rustUncertainOwner.has(fromFile)) return undefined;
  const isRoot = (file: string): boolean => !context.rustDeclaredBy.has(file) && !context.rustUncertainOwner.has(file) && !context.rustOwnershipUnreadable
    && rustRootPlace(file, context.rustTargetRoots, context.cargoRoots);
  const ownDir = base === "mod.rs" || isRoot(fromFile) ? fromDir : path.posix.join(fromDir, base.replace(/\.rs$/, ""));
  const inlineModule = (file: string, names: readonly string[]): boolean => context.rustInlineModules.has(`${file}#${names.join(".")}`);
  const firstKnown = (files: readonly string[]): string | undefined => files.find((file) => knownFiles.has(file));
  // From a module file, each segment is an inline module the file declares, or a module file the file declares
  // with `mod name;` and the index holds beside its children. A module whose path an attribute sets, and a file
  // child of an inline module, live where the index cannot follow: the path names nothing. A segment that is
  // neither (an alias, an item) is left for the item lookup in the current module, which finds it or nothing.
  const walk = (file: string, dir: string, rest: readonly string[]): { file: string; inline: string[] } | undefined => {
    let current = file;
    let currentDir = dir;
    let inline: string[] = [];
    for (let index = 0; index < rest.length; index += 1) {
      const segment = rest[index]!;
      if (inlineModule(current, [...inline, segment])) { inline.push(segment); continue; }
      const declaration = context.rustModuleFiles.get(current)?.get(segment);
      const declared = inline.length === 0 ? declaration : undefined;
      if (declared === "path" || (inline.length > 0 && declaration !== undefined)) return undefined;
      const modulePath = path.posix.join(currentDir, segment);
      const next = declared === "file" ? firstKnown([`${modulePath}.rs`, `${modulePath}/mod.rs`]) : undefined;
      if (next !== undefined && context.rustUncertainOwner.has(next)) return undefined;
      if (next === undefined) return { file: current, inline: [...inline, ...rest.slice(index)] };
      current = next;
      currentDir = modulePath;
      inline = [];
    }
    return { file: current, inline };
  };
  if (head === "crate") {
    // The crate root this file belongs to: follow the files that declare it with `mod name;` up to one nothing
    // declares, which must be a root (lib.rs, main.rs, build.rs, a file directly under tests/, examples/, benches/
    // or src/bin/, or a Cargo target path). Two declaring files, a chain that loops, or an undeclared file that is
    // no root leave the crate unknown, and the path names nothing.
    let root: string | undefined = fromFile;
    for (let hops = 0; root !== undefined && context.rustDeclaredBy.has(root); hops += 1) {
      const declarers: readonly string[] = context.rustDeclaredBy.get(root)!;
      root = declarers.length === 1 && hops < 32 ? declarers[0] : undefined;
    }
    if (root === undefined || !isRoot(root)) return undefined;
    return walk(root, parentOf(root), segments.slice(1));
  }
  if (head === "self" || head === "super") {
    let dir = ownDir;
    let index = 0;
    while (segments[index] === "super" || segments[index] === "self") { if (segments[index] === "super") dir = parentOf(dir); index += 1; }
    const file = dir === ownDir ? fromFile : firstKnown([path.posix.join(dir, "mod.rs"), ...(dir === "" ? [] : [`${dir}.rs`]), path.posix.join(dir, "lib.rs"), path.posix.join(dir, "main.rs")]);
    return file === undefined ? undefined : walk(file, dir, segments.slice(index));
  }
  const headDeclaration = context.rustModuleFiles.get(fromFile)?.get(head);
  if (context.cargoPackages.get(head) === undefined && (inlineModule(fromFile, [head]) || headDeclaration === "file" || headDeclaration === "path")) {
    // `flags::parse::lookup()` with `mod flags;` in this file: a child module named without `self::`.
    return walk(fromFile, ownDir, segments);
  }
  // `grep_matcher::LineTerminator`: another crate of this workspace, by its package name.
  const crate = context.cargoPackages.get(head);
  if (crate === undefined) return undefined;
  let start = srcOf(crate);
  let rest = segments.slice(1);
  // A facade crate names another crate under an alias (`pub extern crate grep_printer as printer;`), so
  // `grep::printer::X` continues from the aliased crate's root. Each hop consumes a segment, so it ends.
  for (let hop = 0; hop < segments.length; hop += 1) {
    const next = rest[0] === undefined ? undefined : context.crateAliases.get(`${start}/lib.rs`)?.get(rest[0]);
    const aliased = next === undefined ? undefined : context.cargoPackages.get(next);
    if (aliased === undefined) break;
    start = srcOf(aliased);
    rest = rest.slice(1);
  }
  const root = firstKnown(["lib.rs", "main.rs", "mod.rs"].map((name) => path.posix.join(start, name)));
  return root === undefined ? undefined : walk(root, start, rest);
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
  // The inline-module path of a Rust symbol: the leading qualified-name parts that are declared modules.
  const moduleOf = (file: string, qualifiedName: string | undefined): string => {
    if (qualifiedName === undefined) return "";
    const parts = qualifiedName.slice(qualifiedName.indexOf("#") + 1).split(".");
    const modules: string[] = [];
    for (let take = 1; take <= parts.length; take += 1) {
      const parent = declaredAs(file, `${file}#${parts.slice(0, take).join(".")}`)[0];
      if (parent?.kind !== "module") break;
      modules.push(parts[take - 1]!);
    }
    return modules.join(".");
  };
  // A local reference names an item of the file. In Rust the referencing site's inline module comes first, then
  // the file's root, then, with no module known, a module item that is the file's only declaration of the name.
  const declaredLocal = (file: string, name: string, module = ""): readonly OsnovaSymbol[] => {
    const root = declaredAs(file, qualifiedNameOf(file, name));
    if (files.get(file)?.language !== "rust" || name.includes(".")) return root;
    if (module !== "") {
      const inner = declaredAs(file, qualifiedNameOf(file, `${module}.${name}`));
      if (inner.length > 0) return inner;
    }
    if (root.length > 0 || module !== "") return root;
    const nested = (symbolsByName.get(name) ?? []).filter((symbol) => symbol.file === file && symbol.qualifiedName === qualifiedNameOf(file, `${moduleOf(file, symbol.qualifiedName)}.${name}`) && moduleOf(file, symbol.qualifiedName) !== "");
    return new Set(nested.map((symbol) => symbol.qualifiedName)).size === 1 ? nested : [];
  };

  const knownFiles = new Set(files.keys());
  const context = workspaceContext(files);
  const externalInput = { lockfiles: context.lockfiles, workspacePackages: new Set(context.packages.keys()), pythonRoots: context.pythonRoots, goModules: new Set(context.goModules.keys()), cargoPackages: new Set(context.cargoPackages.keys()), cargoDependencies: context.cargoDependencies, knownFiles };
  const unresolvedImport = (language: CardLanguage, fromFile: string, spec: string): Extract<EdgeResolution, { status: "unresolved" }> => {
    if ((language === "typescript" || language === "tsx" || language === "javascript") && !spec.startsWith(".") && context.tsConfigs.resolve(fromFile, spec, knownFiles).kind === "ambiguous") return { status: "unresolved", reason: "import-target-ambiguous" };
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
  // The inline-module segments a Rust import continues through inside the target file (see resolveRustPath).
  const inlinePath = (language: CardLanguage, fromFile: string, spec: string): readonly string[] =>
    language === "rust" ? resolveRustPath(fromFile, spec, knownFiles, context)?.inline ?? [] : [];
  const exported = (file: string, name: string, inline: readonly string[] = []): ExportResult => {
    const key = JSON.stringify([file, name, inline]);
    const cached = exportCache.get(key);
    if (cached !== undefined) return cached;
    const result: ExportResult = { symbols: new Map(), routes: new Map(), namespaces: [], incomplete: false, cycle: false };
    const visited = new Set<string>();
    const active = new Set<string>();
    const family = languageFamily(files.get(file)?.language);
    const walk = (currentFile: string, currentName: string, via: readonly ExportHop[], currentInline: readonly string[]): void => {
      const state = JSON.stringify([currentFile, currentName, currentInline]);
      if (active.has(state)) { result.cycle = true; return; }
      if (visited.has(state)) return;
      if (visited.size >= 4096 || via.length > 128) { result.incomplete = true; return; }
      visited.add(state);
      const card = files.get(currentFile);
      if (card === undefined || languageFamily(card.language) !== family) { result.incomplete = true; return; }
      if (card.language === "go") {
        const dir = path.posix.dirname(currentFile);
        for (const [file, other] of files) {
          if (other.language !== "go" || path.posix.dirname(file) !== dir || !sameGoPackage(other, card)) continue;
          for (const symbol of other.symbols) if (symbol.name === currentName && !symbol.qualifiedName.slice(symbol.qualifiedName.indexOf("#") + 1).includes(".")) result.symbols.set(exportKey(symbol), symbol);
        }
        return;
      }
      const links = card.reExports ?? [];
      if (links.some((link) => link.kind === "blocked" && (link.exportedName === currentName || link.exportedName === "*"))) {
        result.incomplete = true;
        return;
      }
      // A Rust item inside an inline module is reached only by a path through that module.
      const localName = [...currentInline, currentName].join(".");
      const direct = card.symbols.filter((symbol) => symbol.exportedNames?.includes(currentName) ||
        (TYPED_FAMILY.has(card.language) && symbol.name === currentName && symbol.qualifiedName.slice(symbol.qualifiedName.indexOf("#") + 1) === localName));
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
        }], inlinePath(card.language, currentFile, link.source));
      }
      active.delete(state);
    };
    walk(file, name, [], inline);
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
    if (base.kind === "local") bases = declaredLocal(holder.file, base.name, moduleOf(holder.file, holder.qualifiedName));
    else {
      const target = resolveImportTarget(holderCard.language, holder.file, base.source, knownFiles, context);
      if (target === undefined) return null;
      const found = exported(target, base.importedName, inlinePath(holderCard.language, holder.file, base.source));
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
      const local = [...declaredLocal(file, ref.name)];
      if (local.length > 0 || !TYPED_FAMILY.has(holderCard.language)) return local;
      const family = languageFamily(holderCard.language);
      return (symbolsByName.get(ref.name) ?? []).filter((symbol) => (isHolder(symbol) || symbol.kind === "function") && languageFamily(files.get(symbol.file)?.language) === family);
    }
    const target = resolveImportTarget(holderCard.language, file, ref.source, knownFiles, context);
    if (target === undefined) return null;
    const found = exported(target, ref.importedName, inlinePath(holderCard.language, file, ref.source));
    return found.incomplete ? null : [...found.symbols.values()];
  };
  const unique = (symbols: OsnovaSymbol[] | null): OsnovaSymbol | undefined =>
    symbols !== null && symbols.length > 0 && new Set(symbols.map((symbol) => symbol.qualifiedName)).size === 1 ? symbols[0] : undefined;

  // Java and C# overload sets reach past the target's file. A C# type written `partial` has its other
  // `partial` declarations of the same local name, namespace and generic arity in other C# files as parts.
  // A base written without an import is the single type of that name in the language, as a receiver
  // annotation is.
  // A file the grammar could not parse cleanly may attribute a nested type's members to its outer type,
  // so a partial type with such a file is not merged.
  const parsedCleanly = (file: string): boolean => parsedWithoutErrors(files.get(file));
  // One C# type: the parts of a partial type share its local name and namespace-and-arity identity;
  // any other type is its own declaration.
  const partialIdentity = (symbol: OsnovaSymbol): string | undefined => declarationsOf(symbol).find((part) => part.partial !== undefined)?.partial;
  // Declarations under one qualified name in one file are one type only when there is one, or all are parts of a
  // partial type with one namespace-and-arity identity: `A.T` and `B.T`, or `T` and `T<U>`, share the name.
  const singleType = (holder: OsnovaSymbol): boolean => {
    const declarations = declarationsOf(holder);
    const identities = new Set(declarations.map((part) => part.partial));
    return declarations.length === 1 || (identities.size === 1 && !identities.has(undefined));
  };
  const typeKey = (symbol: OsnovaSymbol): string => {
    const identity = partialIdentity(symbol);
    return identity === undefined ? symbol.qualifiedName : `${localOfQualifiedName(symbol.qualifiedName)}\u0000${identity}`;
  };
  const partsOf = (holder: OsnovaSymbol): { parts: OsnovaSymbol[]; complete: boolean } => {
    const parts = new Map<string, OsnovaSymbol>([[holder.file, holder]]);
    let complete = true;
    if (files.get(holder.file)?.language === "c_sharp" && partialIdentity(holder) !== undefined) {
      if (!parsedCleanly(holder.file) || !singleType(holder)) return { parts: declarationsOf(holder), complete: false };
      const identity = partialIdentity(holder);
      for (const symbol of symbolsByName.get(holder.name) ?? []) {
        if (!isHolder(symbol) || files.get(symbol.file)?.language !== "c_sharp" || symbol.partial === undefined || parts.has(symbol.file) ||
          localOfQualifiedName(symbol.qualifiedName) !== localOfQualifiedName(holder.qualifiedName)) continue;
        // Another file that declares the name with mixed identities may hold a part the index cannot single out.
        if (!singleType(symbol)) {
          if (declarationsOf(symbol).some((part) => part.partial === identity)) complete = false;
          continue;
        }
        if (typeKey(symbol) !== typeKey(holder)) continue;
        if (parsedCleanly(symbol.file)) parts.set(symbol.file, symbol);
        else complete = false;
      }
    }
    return { parts: [...parts.values()].flatMap((part) => declarationsOf(part)), complete };
  };
  // A Java supertype written as a simple name without an import names a member type that an enclosing
  // type declares or inherits (innermost first), else a top-level type of the same package; a same-named
  // type of another package is not evidence, since the compiler may bind an unindexed type of this
  // package. An enclosing type whose supertypes cannot all be followed leaves the name unknown.
  const javaLocalBaseOf = (part: OsnovaSymbol, name: string): OsnovaSymbol | undefined => {
    const enclosing = localOfQualifiedName(part.qualifiedName).split(".").slice(0, -1);
    for (let depth = enclosing.length; depth > 0; depth -= 1) {
      const outer = declaredAs(part.file, qualifiedNameOf(part.file, enclosing.slice(0, depth).join("."))).find(isHolder);
      if (outer === undefined) return undefined;
      const member = javaMemberTypeOf(outer, name, new Set());
      if (member === null) return undefined;
      if (member !== undefined) return member;
    }
    const home = javaPackageOf(files.get(part.file));
    const holders = (symbolsByName.get(name) ?? []).filter((symbol) => isHolder(symbol) && files.get(symbol.file)?.language === "java" &&
      !localOfQualifiedName(symbol.qualifiedName).includes(".") && javaPackageOf(files.get(symbol.file)) === home);
    return new Set(holders.map((symbol) => symbol.qualifiedName)).size === 1 ? holders[0] : undefined;
  };
  // A type an object creation names, found the way the compiler scopes the written name, or why not.
  type CreatedType = { readonly status: "resolved"; readonly type: OsnovaSymbol; readonly method: "same-file-name" | "imported-file-name" | "lexical-definition" }
    | { readonly status: "ambiguous"; readonly candidates: readonly string[] }
    | { readonly status: "unresolved"; readonly reason: "no-matching-symbol" | "unbound-global" };
  const unknownType: CreatedType = { status: "unresolved", reason: "no-matching-symbol" };
  const externalType: CreatedType = { status: "unresolved", reason: "unbound-global" };
  const oneType = (types: readonly OsnovaSymbol[], method: "same-file-name" | "imported-file-name" | "lexical-definition"): CreatedType | undefined => {
    const names = [...new Set(types.map((symbol) => symbol.qualifiedName))].sort();
    return names.length === 0 ? undefined : names.length === 1 ? { status: "resolved", type: types[0]!, method } : { status: "ambiguous", candidates: names };
  };
  // The Java top-level or nested type `path` (`Outer.Inner`) declared in package `pkg`.
  const javaTypesIn = (pkg: string, path: string): OsnovaSymbol[] =>
    (symbolsByName.get(path.slice(path.lastIndexOf(".") + 1)) ?? []).filter((symbol) => isHolder(symbol) && files.get(symbol.file)?.language === "java" &&
      localOfQualifiedName(symbol.qualifiedName) === path && javaPackageOf(files.get(symbol.file)) === pkg);
  // `a.b.Outer.Inner` as its package `a.b` and type path `Outer.Inner`: the package is the lower-case prefix.
  const javaSplit = (written: string): { pkg: string; path: string } | undefined => {
    const parts = written.split(".");
    const first = parts.findIndex((part) => /^[A-Z_$]/.test(part));
    return first < 0 ? undefined : { pkg: parts.slice(0, first).join("."), path: parts.slice(first).join(".") };
  };
  const codeOf = (card: FileCard): string => {
    const cached = codeCache.get(card);
    if (cached !== undefined) return cached;
    const code = javaCodeOnly(card.text);
    codeCache.set(card, code);
    return code;
  };
  type JavaImports = { single: Map<string, string>; onDemand: string[]; staticSingle: Set<string>; staticOnDemand: boolean };
  // The file's import declarations, read with comments and literals removed, since `import` is a keyword nowhere else.
  const javaImportsOf = (card: FileCard): JavaImports => {
    const cached = javaImportCache.get(card);
    if (cached !== undefined) return cached;
    const found: JavaImports = { single: new Map(), onDemand: [], staticSingle: new Set(), staticOnDemand: false };
    for (const match of codeOf(card).matchAll(/\bimport\s+(static\s+)?([\w$]+(?:\s*\.\s*[\w$]+)*)(\s*\.\s*\*)?\s*;/g)) {
      const path = match[2]!.replace(/\s+/g, "");
      const simple = path.slice(path.lastIndexOf(".") + 1);
      if (match[1] !== undefined) {
        if (match[3] !== undefined) found.staticOnDemand = true;
        else found.staticSingle.add(simple);
      } else if (match[3] !== undefined) found.onDemand.push(path);
      else found.single.set(simple, path);
    }
    javaImportCache.set(card, found);
    return found;
  };
  // A Java simple type name in scope at the creation: a member type of an enclosing type (declared or inherited)
  // or a local class, a top-level type of the file, a single-type import, the package, then the on-demand
  // imports. A name none of them supplies is a java.lang or library type.
  const javaSimpleType = (card: FileCard, fromSymbol: string, name: string): CreatedType => {
    const enclosing = fromSymbol.includes("#") ? localOfQualifiedName(fromSymbol).split(".") : [];
    for (let depth = enclosing.length; depth > 0; depth -= 1) {
      const scope = enclosing.slice(0, depth).join(".");
      const holder = declaredAs(card.path, qualifiedNameOf(card.path, scope)).find(isHolder);
      // A local class is in scope from its declaration to the end of its block, which the index does not
      // record, so a local class of the name in an enclosing method leaves the name unproven.
      if (holder === undefined) {
        if (declaredAs(card.path, qualifiedNameOf(card.path, `${scope}.${name}`)).some(isHolder)) return unknownType;
        continue;
      }
      const member = javaMemberTypeOf(holder, name, new Set());
      if (member === null) return unknownType;
      if (member !== undefined) return { status: "resolved", type: member, method: member.file === card.path ? "same-file-name" : "lexical-definition" };
    }
    const top = declaredAs(card.path, qualifiedNameOf(card.path, name)).find(isHolder);
    if (top !== undefined) return { status: "resolved", type: top, method: "same-file-name" };
    const imports = javaImportsOf(card);
    // A single static import of the name may import a member type, which the index does not follow.
    if (imports.staticSingle.has(name)) return unknownType;
    const imported = imports.single.get(name);
    if (imported !== undefined) {
      const split = javaSplit(imported);
      return (split === undefined ? undefined : oneType(javaTypesIn(split.pkg, split.path), "imported-file-name")) ?? externalType;
    }
    const inPackage = oneType(javaTypesIn(javaPackageOf(card), name), "lexical-definition");
    if (inPackage !== undefined) return inPackage;
    // A static on-demand import may supply a member type of the name, which the index does not follow.
    if (imports.staticOnDemand) return unknownType;
    const onDemand = imports.onDemand.flatMap((path) => {
      const split = javaSplit(`${path}.${name}`);
      return split === undefined ? [] : javaTypesIn(split.pkg, split.path);
    });
    return oneType(onDemand, "imported-file-name") ?? externalType;
  };
  const javaCreatedType = (card: FileCard, fromSymbol: string, written: string): CreatedType => {
    if (!written.includes(".")) return javaSimpleType(card, fromSymbol, written);
    const split = javaSplit(written);
    if (split === undefined) return unknownType;
    if (split.pkg.length > 0) return oneType(javaTypesIn(split.pkg, split.path), "imported-file-name") ?? externalType;
    // `Outer.Inner`: the outer type as a simple name, then a member type it declares.
    const [outerName, ...rest] = split.path.split(".");
    const outer = javaSimpleType(card, fromSymbol, outerName!);
    if (outer.status !== "resolved") return outer;
    const inner = declaredAs(outer.type.file, `${outer.type.qualifiedName}.${rest.join(".")}`).find(isHolder);
    return inner === undefined ? unknownType : { ...outer, type: inner };
  };
  // C# binds a type name by scope: the member types of each enclosing type (declared in any `partial` part, or
  // inherited from its written base class when that resolves to an indexed type), innermost first; then each
  // enclosing namespace from the innermost out, where a namespace's own types come before the types that the
  // `using` directives declared inside it import; and at the global namespace, after its own types, the
  // compilation unit's directives and every `global using`. A dotted name's first segment may name a namespace
  // instead, and `global::` starts at the global namespace. A name any C# file declares as a `using` alias stays
  // unresolved, since an alias can be global or scoped to a namespace. The imports edges carry each directive as
  // `[global ][static ]Target[ in Namespace@from-to]`, or `X =` for an alias, where `in` bounds a directive to the lines of
  // the namespace declaration it is declared inside and its target is read relative to that namespace; a change to them
  // changes the file's imports, which re-resolves every file on an incremental update.
  type CsharpSegment = { readonly name: string; readonly arity: number };
  type CsharpUsing = { readonly conditional: boolean; readonly static: boolean; readonly target: string; readonly scope: string; readonly from: number; readonly to: number };
  type CsharpScope = {
    readonly aliases: Set<string>;
    readonly global: CsharpUsing[];
    readonly byFile: Map<string, CsharpUsing[]>;
    readonly namespaces: Set<string>;
    readonly types: Map<string, OsnovaSymbol[]>;
    // Names of types whose namespace is unknown (`?`) or whose header did not parse (so their arity is unknown), any of
    // which could be the type a lookup of that name means.
    readonly unplaced: Set<string>;
  };
  // A written C# type name segment and its generic arity: ``Box`1`` names `Box<T>`, which a type records as `arity`.
  const csharpSegments = (written: string): CsharpSegment[] => written.split(".").map((part) => {
    const tick = part.indexOf("`");
    return tick < 0 ? { name: part, arity: 0 } : { name: part.slice(0, tick), arity: Number(part.slice(tick + 1)) };
  });
  const arityOf = (symbol: OsnovaSymbol): number => symbol.arity ?? 0;
  // A C# type for name lookup: a holder, or a delegate (kind `type`), which hides a same-named type further out but
  // holds no members and is not a creation target the index can prove.
  const csharpTypeLike = (symbol: OsnovaSymbol): boolean => isHolder(symbol) || (symbol.kind === "type" && files.get(symbol.file)?.language === "c_sharp");
  const typeKeyIn = (namespace: string, segment: CsharpSegment): string => `${namespace}\u0000${segment.name}\u0000${segment.arity}`;
  // Whether more than one C# type of any namespace, nesting or arity has this name: then a type inside an `#if` region,
  // which may not be compiled, could stand in for the one the compiler binds.
  const csharpContestedCache = new Map<string, boolean>();
  const csharpContested = (name: string): boolean => {
    const cached = csharpContestedCache.get(name);
    if (cached !== undefined) return cached;
    const types = (symbolsByName.get(name) ?? []).filter((symbol) => files.get(symbol.file)?.language === "c_sharp" && (isHolder(symbol) || symbol.kind === "type"));
    // Each declaration is its own type, though a delegate and a class of one file can share a qualified name; only the
    // parts of one partial type count once.
    const contested = new Set(types.map((symbol) => symbol.partial === undefined ? symbol : `${localOfQualifiedName(symbol.qualifiedName)}\u0000${symbol.partial}`)).size > 1;
    csharpContestedCache.set(name, contested);
    return contested;
  };
  let csharpScope: CsharpScope | undefined;
  const csharpScopeOf = (): CsharpScope => {
    if (csharpScope !== undefined) return csharpScope;
    const scope: CsharpScope = { aliases: new Set(), global: [], byFile: new Map(), namespaces: new Set(), types: new Map(), unplaced: new Set() };
    for (const [file, raws] of rawEdges) {
      if (files.get(file)?.language !== "c_sharp") continue;
      for (const raw of raws) {
        if (raw.kind !== "imports") continue;
        const alias = /^(\S+) =$/u.exec(raw.toName);
        if (alias !== null) {
          scope.aliases.add(alias[1]!);
          continue;
        }
        const directive = /^(#if )?(global )?(static )?(\S+?)(?: in (\S+)@(\d+)-(\d+))?$/u.exec(raw.toName);
        if (directive === null) continue;
        const using = { conditional: directive[1] !== undefined, static: directive[3] !== undefined, target: directive[4]!, scope: directive[5] ?? "", from: Number(directive[6] ?? 0), to: Number(directive[7] ?? 0) };
        if (directive[2] !== undefined) scope.global.push(using);
        else scope.byFile.set(file, [...(scope.byFile.get(file) ?? []), using]);
      }
    }
    for (const symbols of symbolsByName.values()) {
      for (const symbol of symbols) {
        if (!csharpTypeLike(symbol) || files.get(symbol.file)?.language !== "c_sharp") continue;
        const namespace = symbol.namespace ?? "";
        // A member type records a namespace only when an unbalanced `#if` may make it top-level (`?`).
        if (localOfQualifiedName(symbol.qualifiedName).includes(".")) {
          if (namespace === "?") scope.unplaced.add(symbol.name);
          continue;
        }
        if (namespace === "?" || symbol.unparsedHeader === true || (symbol.conditional === true && csharpContested(symbol.name))) {
          scope.unplaced.add(symbol.name);
          continue;
        }
        const parts = namespace.length === 0 ? [] : namespace.split(".");
        for (let depth = 1; depth <= parts.length; depth += 1) scope.namespaces.add(parts.slice(0, depth).join("."));
        const key = typeKeyIn(namespace, { name: symbol.name, arity: arityOf(symbol) });
        scope.types.set(key, [...(scope.types.get(key) ?? []), symbol]);
      }
    }
    csharpScope = scope;
    return scope;
  };
  // A member type of that name and arity declared in any part of a C# type, as seen from inside it (`own`), from a
  // derived type (`inherited`, which cannot see a private one) or through a `using static` (`imported`, which
  // cannot see a private or protected one); null when a part that did not parse cleanly may hold it, or when the
  // type shares its qualified name with a type of another identity, since the index cannot tell whose members are whose.
  type CsharpView = "own" | "inherited" | "imported";
  const csharpVisible = (symbol: OsnovaSymbol, view: CsharpView): boolean =>
    view === "own" || (symbol.access !== "private" && (view === "inherited" || symbol.access !== "protected"));
  const csharpDeclaredMember = (type: OsnovaSymbol, segment: CsharpSegment, view: CsharpView): OsnovaSymbol | null | undefined => {
    // A delegate declares no member types, though a holder sharing its qualified name may.
    if (type.kind === "type") return undefined;
    if (!singleType(type)) return null;
    const { parts, complete } = partsOf(type);
    const named = parts.flatMap((part) => declaredAs(part.file, `${part.qualifiedName}.${segment.name}`)).filter(csharpTypeLike);
    // A member type whose header did not parse may have any arity.
    if (named.some((symbol) => symbol.unparsedHeader === true || (symbol.conditional === true && csharpContested(segment.name)))) return null;
    const found = named.find((symbol) => arityOf(symbol) === segment.arity && csharpVisible(symbol, view));
    return found ?? (complete ? undefined : null);
  };
  // The namespace of the top-level type that holds this one; null when that type's name is shared by another.
  const csharpNamespaceOf = (file: string, outermost: string): string | null => {
    const holders = declaredAs(file, qualifiedNameOf(file, outermost)).filter(isHolder);
    if (holders.length === 0) return "";
    const namespace = holders[0]!.namespace ?? "";
    return singleType(holders[0]!) && namespace !== "?" ? namespace : null;
  };
  // The indexed base class a C# type inherits member types from: undefined when it writes none, or the written base
  // is outside the index; null when the index cannot tell which type it is.
  // The base is read in the scope of the part that writes it, which can import other namespaces than another part.
  const csharpBaseOf = (type: OsnovaSymbol, guard: Set<string>): OsnovaSymbol | null | undefined => {
    const { parts } = partsOf(type);
    // A part inside an `#if` region, or one that writes its base there, may or may not supply the base.
    if (parts.some((declaration) => declaration.conditional === true)) return null;
    const part = parts.find((declaration) => declaration.baseType !== undefined);
    if (part === undefined) return undefined;
    const written = part.baseType!;
    const card = files.get(part.file);
    const local = localOfQualifiedName(part.qualifiedName).split(".");
    const namespace = csharpNamespaceOf(part.file, local[0]!);
    const key = `${part.file}\u0000${part.qualifiedName}\u0000${part.span.startLine}`;
    if (written === "?" || card === undefined || namespace === null || guard.has(key)) return null;
    guard.add(key);
    const found = csharpResolve({ card, enclosing: local.slice(0, -1), namespace, line: part.span.startLine }, written, guard);
    guard.delete(key);
    return found.status === "resolved" ? found.type : found.status === "unresolved" && found.reason === "unbound-global" ? undefined : null;
  };
  const csharpMemberTypeOf = (type: OsnovaSymbol, segment: CsharpSegment, seen: Set<string>, view: CsharpView, guard: Set<string>): OsnovaSymbol | null | undefined => {
    if (seen.size > 32) return null;
    if (seen.has(typeKey(type))) return undefined;
    seen.add(typeKey(type));
    const own = csharpDeclaredMember(type, segment, view);
    if (own !== undefined) return own;
    const base = csharpBaseOf(type, guard);
    if (base === null) return null;
    // A class or struct inherits member types from its base class only, not from interfaces it implements.
    if (base === undefined || (base.kind === "interface" && type.kind !== "interface")) return undefined;
    return csharpMemberTypeOf(base, segment, seen, "inherited", guard);
  };
  // Where a C# type name is written: its file, the enclosing type and member names (outermost first), the namespace and the line.
  type CsharpSite = { readonly card: FileCard; readonly enclosing: readonly string[]; readonly namespace: string; readonly line: number };
  const csharpFound = (card: FileCard, found: readonly OsnovaSymbol[], method: "imported-file-name" | "lexical-definition"): CreatedType => {
    // The parts of one partial type are one type, named by the part in the creating file or else the first.
    const parts = new Set(found.map(typeKey)).size === 1
      ? [found.find((symbol) => symbol.file === card.path) ?? [...found].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))[0]!] : [...found];
    const chosen = oneType(parts, method) ?? externalType;
    return chosen.status === "resolved" && chosen.type.file === card.path ? { ...chosen, method: "same-file-name" } : chosen;
  };
  const csharpNested = (found: CreatedType, path: readonly CsharpSegment[]): CreatedType => {
    if (found.status !== "resolved") return found;
    let type = found.type;
    for (const segment of path) {
      const inner = csharpDeclaredMember(type, segment, "own");
      if (inner === undefined || inner === null) return unknownType;
      type = inner;
    }
    return { ...found, type };
  };
  // A name rooted in a namespace: a type of that namespace, or a nested namespace when more segments follow.
  // Undefined when the namespace holds neither; unknown when an indexed namespace lacks the type, since a
  // namespace can also hold types the index does not.
  const csharpInNamespace = (card: FileCard, namespace: string, segments: readonly CsharpSegment[]): CreatedType | undefined => {
    const [first, ...rest] = segments;
    if (first === undefined) return undefined;
    const scope = csharpScopeOf();
    const types = scope.types.get(typeKeyIn(namespace, first)) ?? [];
    if (types.length > 0) return csharpNested(csharpFound(card, types, "lexical-definition"), rest);
    const deeper = namespace.length === 0 ? first.name : `${namespace}.${first.name}`;
    if (rest.length > 0 && first.arity === 0 && scope.namespaces.has(deeper)) {
      const inner = csharpInNamespace(card, deeper, rest);
      if (inner !== undefined) return inner;
      // A namespace the index declares merges with .NET's of the same name (`System`, for a polyfill), whose type the
      // rest of the name may be.
      const key = `${deeper}.${rest.map((segment) => segment.arity === 0 ? segment.name : `${segment.name}\`${segment.arity}`).join(".")}`;
      return dotnetType(key) !== undefined ? externalType : unknownType;
    }
    return undefined;
  };
  // The namespaces enclosing a directive, innermost first, which its target is read relative to.
  const csharpPrefixes = (namespace: string): string[] => {
    const parts = namespace.length === 0 ? [] : namespace.split(".");
    return parts.map((_, index) => parts.slice(0, parts.length - index).join(".")).concat([""]);
  };
  // The types some using directives import for a simple name: a type of each imported namespace, or a visible member
  // type of each statically imported type. A directive's target is read relative to the namespace it is declared in.
  // Undefined when none does; null when a directive the index cannot read could supply it before an outer namespace
  // is searched, or names an alias.
  const csharpImported = (card: FileCard, usings: readonly CsharpUsing[], segment: CsharpSegment, scoped: boolean): CreatedType | null | undefined => {
    const scope = csharpScopeOf();
    const found: OsnovaSymbol[] = [];
    let unreadable = false;
    for (const using of usings) {
      const segments = csharpSegments(using.target);
      if (scope.aliases.has(segments[0]!.name)) return null;
      if (!using.static) {
        const namespace = csharpPrefixes(using.scope).map((prefix) => (prefix.length === 0 ? using.target : `${prefix}.${using.target}`)).find((name) => scope.namespaces.has(name));
        if (namespace !== undefined) found.push(...(scope.types.get(typeKeyIn(namespace, segment)) ?? []));
        else unreadable = true;
        continue;
      }
      const host = csharpPrefixes(using.scope).map((prefix) => csharpInNamespace(card, prefix, segments)).find((result) => result !== undefined);
      if (host === undefined || host.status !== "resolved") {
        if (host !== undefined) return null;
        unreadable = true;
        continue;
      }
      const member = csharpDeclaredMember(host.type, segment, "imported");
      if (member === null) return null;
      if (member !== undefined) found.push(member);
    }
    if (found.length > 0) return csharpFound(card, found, "imported-file-name");
    return unreadable && scoped ? null : undefined;
  };
  const csharpResolve = (site: CsharpSite, written: string, guard: Set<string>): CreatedType => {
    const segments = csharpSegments(written);
    const [first, ...rest] = segments;
    if (first === undefined) return unknownType;
    const scope = csharpScopeOf();
    if (first.name.includes("::")) {
      if (!first.name.startsWith("global::")) return unknownType;
      return csharpInNamespace(site.card, "", [{ ...first, name: first.name.slice("global::".length) }, ...rest]) ?? externalType;
    }
    if (scope.aliases.has(first.name)) return unknownType;
    for (let depth = site.enclosing.length; depth > 0; depth -= 1) {
      const holders = declaredAs(site.card.path, qualifiedNameOf(site.card.path, site.enclosing.slice(0, depth).join("."))).filter(isHolder);
      if (holders.length === 0) continue;
      const member = csharpMemberTypeOf(holders[0]!, first, new Set(), "own", guard);
      if (member === null) return unknownType;
      if (member !== undefined) return csharpNested({ status: "resolved", type: member, method: member.file === site.card.path ? "same-file-name" : "lexical-definition" }, rest);
    }
    // Past the enclosing types, a type whose namespace is unknown could be the one any namespace or import supplies.
    if (scope.unplaced.has(first.name)) return unknownType;
    const usings = scope.byFile.get(site.card.path) ?? [];
    const parts = site.namespace.length === 0 ? [] : site.namespace.split(".");
    // A .NET type found at a level, as the namespace's own or through its directives, binds there like an indexed one.
    const dotnetKey = (namespace: string): string => `${namespace.length === 0 ? "" : `${namespace}.`}${first.name}${first.arity === 0 ? "" : `\`${first.arity}`}`;
    for (let depth = parts.length; depth >= 0; depth -= 1) {
      const level = parts.slice(0, depth).join(".");
      const own = csharpInNamespace(site.card, level, segments);
      if (own !== undefined) return own;
      // A .NET type binds here; its member types, which a dotted name would go on to, are not read.
      if (dotnetType(dotnetKey(level)) !== undefined) return rest.length === 0 ? externalType : unknownType;
      // A site on the first or last line of a namespace declaration that holds directives may lie outside it, beside
      // another declaration on that line, so the line cannot tell whether those directives apply.
      const scoped = usings.filter((using) => using.scope === level);
      if (depth > 0 && scoped.some((using) => site.line === using.from || site.line === using.to)) return unknownType;
      const declared = depth === 0 ? [...usings.filter((using) => using.scope === ""), ...scope.global]
        : scoped.filter((using) => using.from < site.line && site.line < using.to);
      // A directive inside an `#if` region may or may not import a type at this level.
      if (declared.some((using) => using.conditional)) return unknownType;
      const imported = declared.length === 0 ? undefined : csharpImported(site.card, declared, first, depth > 0);
      if (imported === null) return unknownType;
      const dotnetImported = declared.some((using) => !using.static && dotnetType(dotnetKey(using.target)) !== undefined);
      // An indexed type and a .NET type imported at one level are ambiguous to the compiler.
      if (imported !== undefined) return dotnetImported ? unknownType : csharpNested(imported, rest);
      if (dotnetImported) return rest.length === 0 ? externalType : unknownType;
    }
    return externalType;
  };
  // In a file that did not parse cleanly, a creation outside any type may have lost the declaration that encloses it,
  // so its scope is unknown.
  const csharpCreatedType = (card: FileCard, fromSymbol: string, written: string, line: number): CreatedType => {
    const enclosing = fromSymbol.includes("#") ? localOfQualifiedName(fromSymbol).split(".") : [];
    if (enclosing.length === 0 && !parsedCleanly(card.path)) return unknownType;
    const namespace = enclosing.length === 0 ? "" : csharpNamespaceOf(card.path, enclosing[0]!);
    return namespace === null ? unknownType : csharpResolve({ card, enclosing, namespace, line }, written, new Set());
  };
  // What `new T(...)` runs: an instance constructor of T written in any part of the type, or T itself when it
  // declares none, declares a primary or canonical constructor, or the creation makes an anonymous subclass.
  const constructorsOf = (type: OsnovaSymbol): { constructors: OsnovaSymbol[]; primary: boolean; complete: boolean } => {
    const { parts, complete } = partsOf(type);
    const constructors = [...new Set(parts.flatMap((part) => declaredAs(part.file, `${part.qualifiedName}.${type.name}`)))]
      .filter((symbol) => symbol.kind === "method" && symbol.parameters?.constructs === true);
    return { constructors, primary: parts.some((part) => part.primary === true), complete };
  };
  const constructedBy = (type: OsnovaSymbol, construction: Construction): OsnovaSymbol => {
    if (construction !== "instance") return type;
    const { constructors, primary } = constructorsOf(type);
    if (primary || constructors.length === 0) return type;
    return constructors.find((symbol) => symbol.file === type.file) ?? constructors[0]!;
  };
  // The member type `name` that a Java type declares or inherits: undefined when it has none, null when a
  // supertype cannot be followed (or is an enum, whose java.lang.Enum declares member types). A supertype's
  // member type is not inherited when it is private, or package-private in another package; it still hides the
  // same name further up that supertype's chain, so the walk does not look past it there.
  const javaMemberTypeOf = (type: OsnovaSymbol, name: string, seen: Set<string>): OsnovaSymbol | null | undefined => {
    if (seen.has(type.qualifiedName) || seen.size > 32) return null;
    seen.add(type.qualifiedName);
    const own = declaredAs(type.file, `${type.qualifiedName}.${name}`).find(isHolder);
    if (own !== undefined) return own;
    if (type.kind === "enum") return null;
    const followed = [...(type.heritage ?? []), ...(type.interfaces ?? [])];
    if (followed.length !== (type.supertypes ?? 0)) return null;
    const home = javaPackageOf(files.get(type.file));
    for (const binding of followed) {
      const base = baseOf(type, binding);
      if (base === undefined) return null;
      const member = javaMemberTypeOf(base, name, seen);
      if (member === null) return null;
      if (member === undefined || member.access === "private" || (member.access === "package" && javaPackageOf(files.get(member.file)) !== home)) continue;
      return member;
    }
    return undefined;
  };
  const baseOf = (part: OsnovaSymbol, base: SymbolBinding): OsnovaSymbol | undefined => {
    if (base.kind === "local" && files.get(part.file)?.language === "java") return javaLocalBaseOf(part, base.name);
    const found = basesOf(part, base)?.[0];
    if (found !== undefined || base.kind !== "local") return found;
    const language = files.get(part.file)?.language;
    if (language !== "java" && language !== "c_sharp") return undefined;
    const holders = (symbolsByName.get(base.name) ?? []).filter((symbol) => isHolder(symbol) && files.get(symbol.file)?.language === language);
    return new Set(holders.map((symbol) => language === "c_sharp" ? typeKey(symbol) : symbol.qualifiedName)).size === 1 ? holders[0] : undefined;
  };
  // The declarations named `member` level by level: the holder's parts, then its declared base class,
  // and so on. A base declaration the holder cannot call (private, or package-private in another Java
  // package) is left out. Interfaces add nothing to a class's overloads here: C# does not inherit their
  // members into a class, and Java's default methods are left out. `complete` is false when a declared
  // base cannot be identified, so declarations further up may be missing. `interfacesClear` (Java) is true when every
  // written supertype up the chain is followed and every method of the name an interface they reach declares is
  // implemented or overridden in the chain, so no interface method (a default one, or an abstract one an abstract
  // class leaves open) adds a choice.
  type OverloadLevels = { levels: OsnovaSymbol[][]; complete: boolean; interfacesClear?: boolean };
  const levelCache = new Map<string, OverloadLevels>();
  const overloadLevelsOf = (holder: OsnovaSymbol, member: string): OverloadLevels => {
    const key = `${holder.qualifiedName}\u0000${member}`;
    const cached = levelCache.get(key);
    if (cached !== undefined) return cached;
    const found = walkLevels(holder, member);
    levelCache.set(key, found);
    return found;
  };
  const walkLevels = (holder: OsnovaSymbol, member: string): OverloadLevels => {
    const levels: OsnovaSymbol[][] = [];
    const visited = new Set<string>();
    const home = javaPackageOf(files.get(holder.file));
    let current: OsnovaSymbol | undefined = holder;
    let complete = true;
    const java = files.get(holder.file)?.language === "java";
    const interfaces: OsnovaSymbol[] = [];
    let followed = true;
    while (current !== undefined) {
      if (visited.has(typeKey(current)) || levels.length > 8) return { levels, complete: false };
      visited.add(typeKey(current));
      const { parts, complete: whole } = partsOf(current);
      complete &&= whole;
      const seen = new Set<string>();
      const inherited = levels.length > 0;
      levels.push(parts.flatMap((part) => {
        const name = `${part.qualifiedName}.${member}`;
        if (seen.has(name)) return [];
        seen.add(name);
        return declaredAs(part.file, name).filter((symbol) => symbol.kind === "method" && !(inherited &&
          (symbol.parameters?.access === "private" || (symbol.parameters?.access === "package" && javaPackageOf(files.get(symbol.file)) !== home))));
      }));
      const bases = new Map<string, OsnovaSymbol>();
      for (const part of parts) {
        if (java) {
          if ((part.heritage?.length ?? 0) + (part.interfaces?.length ?? 0) !== (part.supertypes ?? 0)) followed = false;
          for (const binding of part.interfaces ?? []) {
            const base = baseOf(part, binding);
            if (base === undefined) followed = false;
            else interfaces.push(base);
          }
        }
        for (const binding of part.heritage ?? []) {
          const base = baseOf(part, binding);
          if (base === undefined) return { levels, complete: false };
          if (base.kind === "interface" && current.kind !== "interface") continue;
          bases.set(typeKey(base), base);
        }
      }
      if (bases.size > 1) return { levels, complete: false };
      current = [...bases.values()][0];
    }
    return { levels, complete, ...(java ? { interfacesClear: followed && interfacesAddNone(interfaces, member, levels.flat()) } : {}) };
  };
  // Whether every method named `member` that a Java interface in `pending`, or one it extends, declares has a
  // declaration in `chain` with the same proven parameter types, every written superinterface followed.
  const interfacesAddNone = (pending: OsnovaSymbol[], member: string, chain: readonly OsnovaSymbol[]): boolean => {
    const signature = (symbol: OsnovaSymbol): string | undefined =>
      symbol.parameters?.types !== undefined && javaNamesProven(symbol) ? symbol.parameters.types.join(",") : undefined;
    const implemented = new Set(chain.map(signature).filter((key): key is string => key !== undefined));
    const seen = new Set<string>();
    while (pending.length > 0) {
      const type = pending.pop()!;
      if (seen.has(typeKey(type))) continue;
      seen.add(typeKey(type));
      if (seen.size > 32 || files.get(type.file)?.language !== "java") return false;
      if (declaredAs(type.file, `${type.qualifiedName}.${member}`).some((symbol) => symbol.kind === "method" && !implemented.has(signature(symbol) ?? "\u0000"))) return false;
      const written = [...(type.heritage ?? []), ...(type.interfaces ?? [])];
      if (written.length !== (type.supertypes ?? 0)) return false;
      for (const binding of written) {
        const base = baseOf(type, binding);
        if (base === undefined) return false;
        pending.push(base);
      }
    }
    return true;
  };
  // A simple name a Java parameter type read from its file's scope can still mean another type: a nested
  // type that the declaring type or an enclosing type inherits shadows it, and a type of the same package
  // shadows a java.lang name. The names are proven only when every supertype up each of those chains is
  // indexed and declares no nested type of that name, and no type of the package takes a java.lang name the
  // types rely on. An enum (java.lang.Enum declares a nested type), or any written supertype that names no
  // indexed type (a qualified or external name), leaves them unproven.
  const namesProof = new Map<OsnovaSymbol, boolean>();
  const javaNamesProven = (method: OsnovaSymbol): boolean => {
    const names = method.parameters?.names;
    if (names === undefined) return true;
    const known = namesProof.get(method);
    if (known !== undefined) return known;
    const proven = proveJavaNames(method, names);
    namesProof.set(method, proven);
    return proven;
  };
  const proveJavaNames = (method: OsnovaSymbol, names: readonly string[]): boolean =>
    proveJavaNamesIn(method.file, localOfQualifiedName(method.qualifiedName).split(".").slice(0, -1), names,
      [...(method.parameters?.types ?? []), ...(method.parameters?.erased ?? []).filter((type): type is string => type !== null)]);
  // The same proof for names read at a site inside the named types `enclosing` (outermost first) of a file.
  const proveJavaNamesIn = (file: string, enclosing: readonly string[], names: readonly string[], types: readonly string[]): boolean => {
    const home = javaPackageOf(files.get(file));
    for (const name of names) {
      const relied = types.some((type) => type.split(/[^\w$.]+/).includes(`java.lang.${name}`) ||
        type.split(/[^\w$.]+/).some((part) => part.startsWith(`java.lang.${name}.`)));
      if (relied && (symbolsByName.get(name) ?? []).some((symbol) => isHolder(symbol) && files.get(symbol.file)?.language === "java" &&
        !localOfQualifiedName(symbol.qualifiedName).includes(".") && javaPackageOf(files.get(symbol.file)) === home)) return false;
    }
    const pending: OsnovaSymbol[] = [];
    for (let depth = 1; depth <= enclosing.length; depth += 1) {
      const holder = declaredAs(file, qualifiedNameOf(file, enclosing.slice(0, depth).join("."))).find(isHolder);
      if (holder === undefined) return false;
      pending.push(holder);
    }
    const seen = new Set<string>();
    while (pending.length > 0) {
      const type = pending.pop()!;
      if (seen.has(type.qualifiedName)) continue;
      seen.add(type.qualifiedName);
      if (seen.size > 32 || type.kind === "enum" || files.get(type.file)?.language !== "java") return false;
      if (names.some((name) => declaredAs(type.file, `${type.qualifiedName}.${name}`).some(isHolder))) return false;
      const followed = [...(type.heritage ?? []), ...(type.interfaces ?? [])];
      if (followed.length !== (type.supertypes ?? 0)) return false;
      for (const binding of followed) {
        const base = baseOf(type, binding);
        if (base === undefined) return false;
        pending.push(base);
      }
    }
    return true;
  };
  // Java types by full name (`package.Outer.Inner`), for choosing an overload by argument types. A name two indexed types
  // share is a type the index cannot single out, so its supertypes are unknown.
  let javaTypes: Map<string, OsnovaSymbol[]> | undefined;
  const javaTypeNamed = (type: string): OsnovaSymbol[] | undefined => {
    if (javaTypes === undefined) {
      javaTypes = new Map();
      for (const symbols of symbolsByName.values()) for (const symbol of symbols) {
        if (!isHolder(symbol) || files.get(symbol.file)?.language !== "java") continue;
        const home = javaPackageOf(files.get(symbol.file));
        const name = `${home.length > 0 ? `${home}.` : ""}${localOfQualifiedName(symbol.qualifiedName)}`;
        javaTypes.set(name, [...(javaTypes.get(name) ?? []), symbol]);
      }
    }
    return javaTypes.get(type);
  };
  const javaTypeNameOf = (symbol: OsnovaSymbol): string => {
    const home = javaPackageOf(files.get(symbol.file));
    return `${home.length > 0 ? `${home}.` : ""}${localOfQualifiedName(symbol.qualifiedName)}`;
  };
  const javaSupertypes = new Map<string, readonly (string | null)[]>();
  const javaWorld: JavaTypeWorld = {
    indexed: (type) => javaTypeNamed(type) !== undefined,
    supertypes: (type) => {
      const cached = javaSupertypes.get(type);
      if (cached !== undefined) return cached;
      const holders = javaTypeNamed(type);
      if (holders === undefined) return undefined;
      const supers: (string | null)[] = [];
      if (holders.length !== 1 || declarationsOf(holders[0]!).length !== 1) supers.push(null);
      else {
        const holder = holders[0]!;
        const written = [...(holder.heritage ?? []), ...(holder.interfaces ?? [])];
        for (const binding of written) {
          const base = baseOf(holder, binding);
          if (base !== undefined) supers.push(javaTypeNameOf(base));
          // A supertype imported from outside the index is named by its import; a JDK one has known supertypes.
          else if (binding.kind === "import" && binding.source.endsWith(`.${binding.importedName}`) && javaTypeNamed(binding.source) === undefined) supers.push(binding.source);
          else supers.push(null);
        }
        if (written.length !== (holder.supertypes ?? 0)) supers.push(null);
        if (holder.kind === "enum") supers.push("java.lang.Enum");
        if (holder.primary === true) supers.push("java.lang.Record");
      }
      javaSupertypes.set(type, supers);
      return supers;
    },
  };
  // A declaration's erased parameter types, unknown where its written types prove nothing or another file can shadow them.
  const javaParametersOf = (symbol: OsnovaSymbol): { parameters: (string | null)[]; variable: boolean } => {
    const range = symbol.parameters!;
    const variable = range.max === undefined;
    const count = range.min + (variable ? 1 : 0);
    // A written type with a type argument other than `?` is marked `~`: its erasure fitting does not prove it fits.
    // An `erased` entry comes marked already.
    const erase = (type: string): string => {
      let text = type.replace(/<\?(?:,\?)*>/gu, "");
      const parameterized = text.includes("<");
      for (let previous = ""; previous !== text;) { previous = text; text = text.replace(/<[^<>]*>/g, ""); }
      text = text.endsWith("...") ? `${text.slice(0, -3)}[]` : text;
      return parameterized ? `~${text}` : text;
    };
    const written = range.types ?? range.erased;
    if (written === undefined || written.length !== count || !javaNamesProven(symbol)) return { parameters: new Array<null>(count).fill(null), variable };
    return { parameters: written.map((type) => type === null ? null : erase(type)), variable };
  };
  // The written argument types of a Java call, each one read from the caller's scope kept only when no inherited nested
  // type of the caller's enclosing types can shadow its names.
  const javaArgumentTypesOf = (edge: OsnovaEdge): (string | null)[] | undefined => {
    const written = edge.argumentTypes;
    if (written === undefined || files.get(edge.fromFile)?.language !== "java") return undefined;
    const names = written.names ?? [];
    if (names.length === 0) return [...written.types];
    const local = localOfQualifiedName(edge.fromSymbol);
    const segments = local.length === 0 ? [] : local.split(".");
    const enclosing = segments.length > 0 && declaredAs(edge.fromFile, edge.fromSymbol).some(isHolder) ? segments : segments.slice(0, -1);
    const proven = proveJavaNamesIn(edge.fromFile, enclosing, names, written.types.filter((type): type is string => type !== null));
    // Without the proof, a type keeps only when none of its name's segments came from the scope (a literal's, or `this`).
    return proven ? [...written.types] : written.types.map((type) => type === null || type.split(/[.[\]]+/).some((part) => names.includes(part)) ? null : type);
  };
  // The one candidate a Java call's written argument types select, when the candidates are every declaration it can bind.
  const chooseJavaByTypes = (edge: OsnovaEdge, candidates: readonly OsnovaSymbol[]): OsnovaSymbol | undefined => {
    const args = javaArgumentTypesOf(edge);
    if (args === undefined || args.every((type) => type === null) || candidates.some((symbol) => files.get(symbol.file)?.language !== "java" || symbol.parameters === undefined)) return undefined;
    return chooseByArgumentTypes(javaWorld, candidates.map((item) => ({ item, ...javaParametersOf(item) })), args);
  };
  // An override hides one base declaration with the same parameter range (and, in Java, the same written
  // parameter types). When a level holds more
  // declarations of that range than overrides above it, which ones stay is unknown, so all are listed.
  // A creation chooses among the instance constructors of every part of its type, never a base type's, since
  // constructors are not inherited. One that alone takes the argument count is named (the edge moves to it when it
  // lies in another part); otherwise the accepting ones are listed, and a part that did not parse cleanly leaves
  // even one accepting constructor unproven.
  const chooseConstructor = (edge: OsnovaEdge): OsnovaEdge => {
    const { overload: _previous, ...rest } = edge;
    if (edge.arguments === undefined || edge.toFile === undefined || edge.toSymbol === undefined) return rest;
    const targets = declaredAs(edge.toFile, edge.toSymbol);
    if (targets.some(isHolder)) return rest;
    const holderName = edge.toSymbol.slice(0, edge.toSymbol.lastIndexOf("."));
    const holder = declaredAs(edge.toFile, holderName).find(isHolder);
    if (holder === undefined) return rest;
    const { constructors, complete } = constructorsOf(holder);
    const count = edge.arguments;
    const accepting = constructors.filter((symbol) => accepts(symbol.parameters!, count));
    const isOwn = (symbol: OsnovaSymbol): boolean => symbol.file === edge.toFile && symbol.qualifiedName === edge.toSymbol;
    // Several constructors that take the count: the written argument types may still single one out.
    const typed = complete && accepting.length > 1 ? chooseJavaByTypes(edge, accepting) : undefined;
    if (typed !== undefined) {
      if (!isOwn(typed)) return { ...rest, toSymbol: typed.qualifiedName, toFile: typed.file, overload: { line: typed.span.startLine, from: edge.toSymbol, types: true } };
      return { ...rest, overload: { line: typed.span.startLine, types: true } };
    }
    if (complete && accepting.length === 1) {
      const chosen = accepting[0]!;
      if (!isOwn(chosen)) return { ...rest, toSymbol: chosen.qualifiedName, toFile: chosen.file, overload: { line: chosen.span.startLine, from: edge.toSymbol } };
      // The chosen line is kept whenever another declaration (an excluded method or static constructor too)
      // shares the name, since that one could otherwise stand for the target.
      return declaredAs(edge.toFile, edge.toSymbol).length > 1 ? { ...rest, overload: { line: chosen.span.startLine } } : rest;
    }
    const candidates = accepting.filter(isOwn).map((symbol) => symbol.span.startLine).sort((a, b) => a - b);
    const elsewhere = accepting.filter((symbol) => !isOwn(symbol)).map((symbol) => ({ file: symbol.file, line: symbol.span.startLine }))
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
    return { ...rest, overload: { candidates, ...(elsewhere.length > 0 ? { elsewhere } : {}) } };
  };
  // C# extension methods. A member call `x.M(...)` that names no member of x's type binds an extension method: the
  // compiler searches the innermost namespace declaration first, then each enclosing one, then the compilation unit; at
  // each level the candidates are the extension methods of static classes declared directly in that namespace and in
  // the namespaces the level's `using` directives import, and the first level with an applicable candidate wins. The
  // receiver converts to the `this` parameter only by identity, reference or boxing conversion. The written type of the
  // receiver decides here when exactly one candidate at that level can take it.
  type CsharpType =
    | { readonly kind: "repo"; readonly symbol: OsnovaSymbol; readonly args: readonly CsharpType[] }
    | { readonly kind: "dotnet"; readonly key: string }
    | { readonly kind: "external"; readonly name: string; readonly args: readonly CsharpType[] }
    | { readonly kind: "array"; readonly element: CsharpType; readonly rank: number }
    | { readonly kind: "nullable"; readonly inner: CsharpType }
    | { readonly kind: "parameter"; readonly name: string };
  const CSHARP_KEYWORDS: Readonly<Record<string, string>> = {
    bool: "System.Boolean", byte: "System.Byte", sbyte: "System.SByte", char: "System.Char", short: "System.Int16", ushort: "System.UInt16",
    int: "System.Int32", uint: "System.UInt32", long: "System.Int64", ulong: "System.UInt64", float: "System.Single", double: "System.Double",
    decimal: "System.Decimal", string: "System.String", object: "System.Object",
  };
  const DOTNET_REFERENCE = new Set(["System.String", "System.Object", "System.Array", "System.Enum", "System.ValueType", "System.Type"]);
  // The SDK's implicit global usings, which a project with ImplicitUsings imports from a file the index does not see.
  const IMPLICIT_USINGS = ["System", "System.Collections.Generic", "System.IO", "System.Linq", "System.Net.Http", "System.Threading", "System.Threading.Tasks"];
  // A written type split into its dotted name with type arguments and its `?` and `[]` suffixes, outermost last.
  const splitCsharpType = (written: string): { name: string; args: string[]; suffixes: string[] } | undefined => {
    let end = written.length;
    const suffixes: string[] = [];
    while (end > 0) {
      if (written[end - 1] === "?") { suffixes.unshift("?"); end -= 1; continue; }
      if (written[end - 1] === "]") { const open = written.lastIndexOf("[", end - 1); if (open < 0) return undefined; suffixes.unshift(written.slice(open, end)); end = open; continue; }
      break;
    }
    const base = written.slice(0, end);
    // The type arguments of the last segment; an earlier segment's (`Outer<int>.Inner`) are not read.
    if (!base.endsWith(">")) return base.includes("<") ? undefined : { name: base, args: [], suffixes };
    let depth = 0;
    let open = -1;
    for (let i = base.length - 1; i >= 0; i -= 1) {
      if (base[i] === ">") depth += 1;
      else if (base[i] === "<" && --depth === 0) { open = i; break; }
    }
    if (open <= 0 || base.slice(0, open).includes("<")) return undefined;
    const args: string[] = [];
    let start = open + 1;
    depth = 0;
    for (let i = open + 1; i < base.length - 1; i += 1) {
      if (base[i] === "<") depth += 1;
      else if (base[i] === ">") depth -= 1;
      else if (base[i] === "," && depth === 0) { args.push(base.slice(start, i)); start = i + 1; }
    }
    args.push(base.slice(start, base.length - 1));
    return { name: base.slice(0, open), args, suffixes };
  };
  // A public top-level .NET type by its full name with generic arity: its kind (c class, C sealed class, s struct, r ref
  // struct, e enum, i interface, d delegate), whether it declares an implicit conversion, and its base class.
  type DotnetType = { readonly kind: string; readonly implicit: boolean; readonly base?: string | undefined };
  let dotnetTypes: Map<string, DotnetType> | undefined;
  const dotnetType = (key: string): DotnetType | undefined => {
    if (dotnetTypes === undefined) {
      dotnetTypes = new Map();
      for (const [namespace, entries] of DOTNET_TYPES) {
        for (const entry of entries.split(" ")) {
          const match = /^([^:]+):([cCsreid])(\+?)(?:<(.+))?$/u.exec(entry);
          if (match !== null) dotnetTypes.set(namespace.length === 0 ? match[1]! : `${namespace}.${match[1]}`, { kind: match[2]!, implicit: match[3] === "+", base: match[4] });
        }
      }
    }
    return dotnetTypes.get(key);
  };
  // The .NET type a simple name no indexed type supplies stands for at a site: at each namespace level from the innermost
  // out, a type of that namespace, then the types the level's `using` directives import (the SDK's implicit usings and
  // every `global using` at the compilation unit). Undefined when no .NET type of the name is visible; null when the
  // index cannot tell (two imports supply it, an alias or a `using static` may). A third-party package is taken to
  // declare no type of the name in a namespace the site sees.
  const dotnetNamed = (site: CsharpSite, name: string): string | null | undefined => {
    const scope = csharpScopeOf();
    if (scope.aliases.has(name)) return null;
    const usings = scope.byFile.get(site.card.path) ?? [];
    const parts = site.namespace.length === 0 ? [] : site.namespace.split(".");
    for (let depth = parts.length; depth >= 0; depth -= 1) {
      const level = parts.slice(0, depth).join(".");
      const own = level.length === 0 ? name : `${level}.${name}`;
      if (dotnetType(own) !== undefined) return own;
      const scoped = usings.filter((using) => using.scope === level);
      // A site on the line a namespace declaration opens or closes on may be inside it or not.
      if (depth > 0 && scoped.some((using) => site.line === using.from || site.line === using.to)) return null;
      const directives = depth === 0 ? [...usings.filter((using) => using.scope === ""), ...scope.global]
        : scoped.filter((using) => using.from < site.line && site.line < using.to);
      if (directives.some((using) => using.conditional || using.static)) return null;
      const imported = new Set(directives.map((using) => using.target));
      if (depth === 0) for (const implicit of IMPLICIT_USINGS) imported.add(implicit);
      const hits = [...imported].filter((namespace) => dotnetType(`${namespace}.${name}`) !== undefined);
      if (hits.length > 1) return null;
      if (hits.length === 1) return `${hits[0]}.${name}`;
    }
    return undefined;
  };
  const valueType = (type: CsharpType): boolean | null => {
    if (type.kind === "dotnet") {
      const info = dotnetType(type.key);
      return info === undefined ? !DOTNET_REFERENCE.has(type.key) : info.kind === "s" || info.kind === "r" || info.kind === "e";
    }
    return type.kind === "repo" ? type.symbol.kind === "struct" || type.symbol.kind === "enum" : type.kind === "nullable" ? true : type.kind === "array" ? false : null;
  };
  // A written type read at a site; null when the index cannot tell which type it names. `generic` lists type parameter
  // names that stand for themselves (an extension method's own).
  const csharpTypeAt = (site: CsharpSite, written: string, generic: readonly string[] = [], depth = 0): CsharpType | null => {
    if (depth > 6) return null;
    if (written === "this") {
      for (let level = site.enclosing.length; level > 0; level -= 1) {
        const holder = declaredAs(site.card.path, qualifiedNameOf(site.card.path, site.enclosing.slice(0, level).join("."))).find(isHolder);
        if (holder !== undefined) return arityOf(holder) > 0 ? null : { kind: "repo", symbol: holder, args: [] };
      }
      return null;
    }
    const parts = splitCsharpType(written);
    if (parts === undefined) return null;
    let type: CsharpType | null;
    if (parts.args.length === 0 && generic.includes(parts.name)) type = { kind: "parameter", name: parts.name };
    else if (parts.args.length === 0 && CSHARP_KEYWORDS[parts.name] !== undefined) type = { kind: "dotnet", key: CSHARP_KEYWORDS[parts.name]! };
    else if (parts.args.length === 0 && (parts.name === "dynamic" || parts.name === "nint" || parts.name === "nuint" || parts.name === "var")) type = null;
    else {
      const args = parts.args.map((arg) => csharpTypeAt(site, arg, generic, depth + 1));
      if (args.some((arg) => arg === null)) return null;
      const aritied = parts.name.split(".").map((segment, i, all) => i === all.length - 1 && parts.args.length > 0 ? `${segment}\`${parts.args.length}` : segment).join(".");
      const found = csharpResolve(site, aritied, new Set());
      if (found.status === "resolved") type = { kind: "repo", symbol: found.type, args: args as CsharpType[] };
      else if (found.status === "unresolved" && found.reason === "unbound-global") {
        // A name no indexed type supplies is a library type: a listed .NET type when it names one (`DateTime` under the
        // SDK's implicit `using System;`, or `System.DateTime`).
        const simple = parts.name.replace(/^global::/u, "");
        const dotted = simple.includes(".");
        const key = parts.args.length > 0 ? undefined
          : dotted ? (dotnetType(simple) !== undefined && !csharpScopeOf().aliases.has(simple.slice(0, simple.indexOf("."))) ? simple : undefined) : dotnetNamed(site, simple);
        if (key === null) return null;
        type = key !== undefined ? { kind: "dotnet", key } : { kind: "external", name: simple, args: args as CsharpType[] };
      } else type = null;
    }
    for (const suffix of parts.suffixes) {
      if (type === null) return null;
      if (suffix === "?") {
        // `T?` is Nullable<T> for a value type and the same type, annotated, for a reference type.
        const value = valueType(type);
        if (value === null) return null;
        if (value && type.kind !== "nullable") type = { kind: "nullable", inner: type };
      } else type = { kind: "array", element: type, rank: suffix.length - 1 };
    }
    return type;
  };
  const sameCsharpType = (a: CsharpType, b: CsharpType): boolean | null => {
    if (a.kind === "parameter" || b.kind === "parameter") return null;
    if (a.kind !== b.kind) return a.kind === "external" || b.kind === "external" ? null : false;
    switch (a.kind) {
      case "dotnet": return a.key === (b as typeof a).key;
      case "repo": {
        const other = b as typeof a;
        if (typeKey(a.symbol) !== typeKey(other.symbol)) return false;
        return pairwise(a.args, other.args);
      }
      case "external": {
        const other = b as typeof a;
        return a.name === other.name && a.args.length === other.args.length ? pairwise(a.args, other.args) : null;
      }
      case "array": return a.rank === (b as typeof a).rank ? sameCsharpType(a.element, (b as typeof a).element) : false;
      case "nullable": return sameCsharpType(a.inner, (b as typeof a).inner);
    }
  };
  const pairwise = (a: readonly CsharpType[], b: readonly CsharpType[]): boolean | null => {
    if (a.length !== b.length) return false;
    let all: boolean | null = true;
    for (let i = 0; i < a.length; i += 1) {
      const same = sameCsharpType(a[i]!, b[i]!);
      if (same === false) return false;
      if (same === null) all = null;
    }
    return all;
  };
  // The indexed class a C# class inherits from: undefined for none written (System.Object), null when the written base
  // is outside the index or the index cannot tell which type it is.
  const csharpClassBaseOf = (type: OsnovaSymbol): OsnovaSymbol | null | undefined => {
    if (type.baseType === undefined) return undefined;
    const base = csharpBaseOf(type, new Set());
    return base === undefined ? null : base;
  };
  const refStruct = (type: OsnovaSymbol): boolean => type.kind === "struct" && partsOf(type).parts.some((part) => part.refStruct === true);
  // Implicit numeric conversions between the .NET numeric types (nint and nuint are IntPtr and UIntPtr).
  const NUMERIC_WIDENING: Readonly<Record<string, readonly string[]>> = {
    "System.SByte": ["System.Int16", "System.Int32", "System.Int64", "System.IntPtr", "System.Single", "System.Double", "System.Decimal"],
    "System.Byte": ["System.Int16", "System.UInt16", "System.Int32", "System.UInt32", "System.Int64", "System.UInt64", "System.IntPtr", "System.UIntPtr", "System.Single", "System.Double", "System.Decimal"],
    "System.Int16": ["System.Int32", "System.Int64", "System.IntPtr", "System.Single", "System.Double", "System.Decimal"],
    "System.UInt16": ["System.Int32", "System.UInt32", "System.Int64", "System.UInt64", "System.IntPtr", "System.UIntPtr", "System.Single", "System.Double", "System.Decimal"],
    "System.Int32": ["System.Int64", "System.IntPtr", "System.Single", "System.Double", "System.Decimal"],
    "System.UInt32": ["System.Int64", "System.UInt64", "System.UIntPtr", "System.Single", "System.Double", "System.Decimal"],
    "System.Int64": ["System.Single", "System.Double", "System.Decimal"],
    "System.UInt64": ["System.Single", "System.Double", "System.Decimal"],
    "System.IntPtr": ["System.Int64", "System.Single", "System.Double", "System.Decimal"],
    "System.UIntPtr": ["System.UInt64", "System.Single", "System.Double", "System.Decimal"],
    "System.Char": ["System.UInt16", "System.Int32", "System.UInt32", "System.Int64", "System.UInt64", "System.IntPtr", "System.UIntPtr", "System.Single", "System.Double", "System.Decimal"],
    "System.Single": ["System.Double"],
  };
  // The values an int constant converts to by an implicit constant conversion.
  const CONSTANT_RANGE: Readonly<Record<string, readonly [bigint, bigint]>> = {
    "System.SByte": [-128n, 127n], "System.Byte": [0n, 255n], "System.Int16": [-32768n, 32767n], "System.UInt16": [0n, 65535n],
    "System.UInt32": [0n, 4294967295n], "System.UInt64": [0n, 18446744073709551615n],
  };
  const LITERAL_KEYS: Readonly<Record<string, string>> = { int: "System.Int32", uint: "System.UInt32", long: "System.Int64", ulong: "System.UInt64" };
  const widens = (from: CsharpType, to: CsharpType): boolean => from.kind === "dotnet" && to.kind === "dotnet" && (NUMERIC_WIDENING[from.key]?.includes(to.key) ?? false);
  const refStructType = (type: CsharpType): boolean => (type.kind === "repo" && refStruct(type.symbol)) || (type.kind === "dotnet" && dotnetType(type.key)?.kind === "r");
  // Whether a type or one of its base classes may declare an implicit conversion, which can convert where no standard
  // conversion does: null when the index cannot tell.
  const mayConvertImplicitly = (type: CsharpType): boolean | null => {
    switch (type.kind) {
      case "array": return false;
      case "nullable": return mayConvertImplicitly(type.inner);
      case "external":
      case "parameter": return null;
      case "dotnet": {
        const seen = new Set<string>();
        for (let key: string | undefined = type.key; key !== undefined && !seen.has(key); key = dotnetType(key)?.base) {
          seen.add(key);
          const info = dotnetType(key);
          if (info === undefined) return null;
          if (info.implicit) return true;
        }
        return false;
      }
      case "repo": {
        const seen = new Set<string>();
        let current: OsnovaSymbol | null | undefined = type.symbol;
        while (current !== undefined) {
          if (current === null || seen.has(typeKey(current)) || seen.size > 16) return null;
          seen.add(typeKey(current));
          const { parts, complete } = partsOf(current);
          if (!complete || parts.some((part) => !parsedCleanly(part.file))) return null;
          if (parts.some((part) => part.members?.includes("op_Implicit") === true)) return true;
          if (current.kind !== "class") return current.kind === "struct" || current.kind === "enum" || current.kind === "interface" ? false : null;
          current = csharpClassBaseOf(current);
        }
        return false;
      }
    }
  };
  // Whether a value of type `r` converts to type `p` by identity, implicit reference or boxing conversion: null when the
  // index cannot tell.
  const referenceOrBoxing = (r: CsharpType, p: CsharpType): boolean | null => {
    if (p.kind === "parameter" || r.kind === "parameter") return null;
    const same = sameCsharpType(r, p);
    if (same !== false) return same;
    // A ref struct never boxes, so it converts to no class or interface type.
    if (refStructType(r)) return false;
    if (p.kind === "dotnet") {
      if (p.key === "System.Object") return r.kind === "external" ? null : true;
      if (p.key === "System.ValueType") return valueType(r) ?? null;
      // A nullable enum boxes to its enum's boxed value, so it converts to System.Enum too.
      if (p.key === "System.Enum") {
        const enumType = r.kind === "nullable" ? r.inner : r;
        return enumType.kind === "repo" ? enumType.symbol.kind === "enum" : enumType.kind === "dotnet" ? dotnetType(enumType.key)?.kind === "e" : enumType.kind === "external" ? null : false;
      }
      if (p.key === "System.Array") return r.kind === "array" ? true : r.kind === "external" ? null : false;
      const info = dotnetType(p.key);
      if (info === undefined || r.kind === "external") return null;
      // Which interfaces a type implements is not read.
      if (info.kind === "i") return null;
      // Only a class derives from a class: up a .NET class's bases, or an indexed class's.
      if (info.kind === "c") {
        if (r.kind === "dotnet") {
          const seen = new Set<string>();
          for (let key = dotnetType(r.key)?.base; key !== undefined && !seen.has(key); key = dotnetType(key)?.base) {
            if (key === p.key) return true;
            seen.add(key);
          }
          return dotnetType(r.key) === undefined ? null : false;
        }
        if (r.kind === "repo") {
          if (r.symbol.kind !== "class") return r.symbol.kind === "struct" || r.symbol.kind === "enum" || r.symbol.kind === "interface" ? false : null;
          const seen = new Set<string>();
          let current: OsnovaSymbol | null | undefined = r.symbol;
          while (current !== undefined) {
            if (current === null || seen.has(typeKey(current)) || seen.size > 16) return null;
            seen.add(typeKey(current));
            current = csharpClassBaseOf(current);
          }
          return false;
        }
        return false;
      }
      // A sealed class, struct, enum or delegate: only its own values.
      return false;
    }
    if (p.kind === "nullable") return r.kind === "external" ? null : false;
    if (p.kind === "array") {
      if (r.kind !== "array") return r.kind === "external" ? null : false;
      if (r.rank !== p.rank) return false;
      // Array covariance converts reference elements only.
      return valueType(r.element) === false && valueType(p.element) === false ? referenceOrBoxing(r.element, p.element) : sameCsharpType(r.element, p.element);
    }
    if (p.kind === "repo") {
      if (r.kind !== "repo") return r.kind === "external" ? null : false;
      if (p.symbol.kind !== "interface" && p.symbol.kind !== "class") return false;
      // Up the class chain; an interface the receiver implements is not read here.
      let current: OsnovaSymbol | null | undefined = r.symbol;
      const seen = new Set<string>();
      while (current !== undefined && current !== null && !seen.has(typeKey(current))) {
        seen.add(typeKey(current));
        if (typeKey(current) === typeKey(p.symbol)) return p.args.length === 0 && r.args.length === 0 ? true : null;
        if (current.kind !== "class") break;
        current = csharpClassBaseOf(current);
      }
      if (current === null || p.symbol.kind === "interface") return null;
      return r.symbol.kind === "class" || r.symbol.kind === "struct" || r.symbol.kind === "enum" ? false : null;
    }
    return null;
  };
  // An extension method's receiver converts to its `this` parameter by identity, reference or boxing conversion only.
  const receiverConverts = referenceOrBoxing;
  // Whether a value of type `r` converts implicitly to `p` as an argument: a standard conversion (identity, numeric,
  // nullable, reference or boxing), or null when a user-defined implicit conversion may apply.
  const argumentConverts = (r: CsharpType, p: CsharpType): boolean | null => {
    let standard = referenceOrBoxing(r, p);
    if (standard === true) return true;
    if (widens(r, p)) return true;
    if (p.kind === "nullable") {
      // A value, or a nullable value, converts to a nullable of a type it converts to by identity or numeric conversion.
      const inner = r.kind === "nullable" ? r.inner : r;
      const same = sameCsharpType(inner, p.inner);
      if (same === true || widens(inner, p.inner)) return true;
      if (same === null) standard = null;
    }
    if (standard === false && (mayConvertImplicitly(r) !== false || mayConvertImplicitly(p) !== false)) return null;
    return standard;
  };
  // One argument as written at a call: a type, the null literal, or an integer literal with its value.
  type CsharpArgument = { readonly kind: "type"; readonly type: CsharpType } | { readonly kind: "null" } | { readonly kind: "literal"; readonly key: string; readonly value: bigint };
  const csharpArgumentAt = (site: CsharpSite, written: string | null): CsharpArgument | null => {
    if (written === null || written === "#named" || written === "#ref") return null;
    if (written === "#null") return { kind: "null" };
    const literal = /^#lit:(int|uint|long|ulong):(-?\d+)$/u.exec(written);
    if (literal !== null) return { kind: "literal", key: LITERAL_KEYS[literal[1]!]!, value: BigInt(literal[2]!) };
    if (written.startsWith("=")) {
      // `E.M`: an enum member when E names an enum that declares M; a static member's type is not read.
      const dotted = written.slice(1);
      const owner = csharpTypeAt(site, dotted.slice(0, dotted.lastIndexOf(".")));
      const member = dotted.slice(dotted.lastIndexOf(".") + 1);
      if (owner?.kind === "repo" && owner.symbol.kind === "enum" && parsedCleanly(owner.symbol.file) && owner.symbol.members?.includes(member) === true) return { kind: "type", type: owner };
      if (owner?.kind === "dotnet" && dotnetType(owner.key)?.kind === "e") return { kind: "type", type: owner };
      return null;
    }
    const type = csharpTypeAt(site, written);
    return type === null ? null : { kind: "type", type };
  };
  // Whether an argument converts implicitly to a parameter type: null when the index cannot tell.
  const argumentFits = (argument: CsharpArgument, p: CsharpType): boolean | null => {
    if (p.kind === "parameter") return null;
    if (argument.kind === "type") return argumentConverts(argument.type, p);
    if (argument.kind === "null") return p.kind === "nullable" ? true : valueType(p) === null ? null : !valueType(p);
    const q = p.kind === "nullable" ? p.inner : p;
    const natural: CsharpType = { kind: "dotnet", key: argument.key };
    if (q.kind === "dotnet") {
      if (q.key === argument.key || widens(natural, q)) return true;
      const range = CONSTANT_RANGE[q.key];
      if (argument.key === "System.Int32" && range !== undefined && argument.value >= range[0] && argument.value <= range[1]) return true;
      if (argument.key === "System.Int64" && q.key === "System.UInt64" && argument.value >= 0n) return true;
      if (p.kind !== "nullable" && (q.key === "System.Object" || q.key === "System.ValueType")) return true;
      const info = dotnetType(q.key);
      // The constant zero converts to any enum type.
      if (info?.kind === "e") return argument.value === 0n;
      if (info === undefined || info.kind === "i") return null;
      return mayConvertImplicitly(q) !== false ? null : false;
    }
    if (q.kind === "repo") {
      if (q.symbol.kind === "enum") return argument.value === 0n;
      return mayConvertImplicitly(q) !== false ? null : false;
    }
    return q.kind === "array" ? false : null;
  };
  // Whether an argument's type is identical to a parameter type, which makes its conversion better than any other.
  const exactly = (argument: CsharpArgument, p: CsharpType): boolean | null =>
    argument.kind === "type" ? sameCsharpType(argument.type, p) : argument.kind === "literal" ? sameCsharpType({ kind: "dotnet", key: argument.key }, p) : false;
  const SIGNED_BETTER: Readonly<Record<string, readonly string[]>> = {
    "System.SByte": ["System.Byte", "System.UInt16", "System.UInt32", "System.UInt64"],
    "System.Int16": ["System.UInt16", "System.UInt32", "System.UInt64"],
    "System.Int32": ["System.UInt32", "System.UInt64"],
    "System.Int64": ["System.UInt64"],
  };
  // Which of two parameter types an argument converts to better: 1 for `p`, -1 for `q`, 0 for neither, null when the
  // index cannot tell.
  const betterConversion = (argument: CsharpArgument, p: CsharpType, q: CsharpType): number | null => {
    const same = sameCsharpType(p, q);
    if (same === true) return 0;
    if (same === null) return null;
    const exactP = exactly(argument, p);
    const exactQ = exactly(argument, q);
    if (exactP === null || exactQ === null) return null;
    if (exactP !== exactQ) return exactP ? 1 : -1;
    const pq = argumentConverts(p, q);
    const qp = argumentConverts(q, p);
    if (pq === null || qp === null) return null;
    if (pq && !qp) return 1;
    if (qp && !pq) return -1;
    if (p.kind === "dotnet" && q.kind === "dotnet") {
      if (SIGNED_BETTER[p.key]?.includes(q.key) === true) return 1;
      if (SIGNED_BETTER[q.key]?.includes(p.key) === true) return -1;
    }
    return 0;
  };
  // Whether member lookup on a receiver of this type can find a member named `name`, which keeps the call from binding
  // an extension method: false only when every member of the type and its bases is known.
  const memberMayExist = (type: CsharpType, name: string): boolean => {
    const listed = (key: string): boolean => DOTNET_MEMBERS.get(key)?.has(name) ?? true;
    switch (type.kind) {
      case "dotnet": return listed(type.key);
      case "array": return listed("System.Array");
      case "nullable": return listed("System.Nullable`1");
      case "external":
      case "parameter": return true;
      case "repo": {
        const seen = new Set<string>();
        let current: OsnovaSymbol | null | undefined = type.symbol;
        while (current !== undefined) {
          if (current === null || seen.has(typeKey(current)) || seen.size > 16) return true;
          seen.add(typeKey(current));
          const { parts, complete } = partsOf(current);
          // A part that did not parse cleanly may have lost members.
          if (!complete || parts.some((part) => !parsedCleanly(part.file))) return true;
          if (parts.some((part) => part.members?.includes(name) === true)) return true;
          // A delegate has Invoke and the members of System.Delegate, which no table lists.
          if (current.kind !== "class" && current.kind !== "struct" && current.kind !== "interface" && current.kind !== "enum") return true;
          if (current.kind === "enum") return listed("System.Enum");
          if (current.kind === "struct") return listed("System.ValueType");
          if (current.kind === "interface") return current.baseType !== undefined || listed("System.Object");
          current = csharpClassBaseOf(current);
        }
        return listed("System.Object");
      }
    }
  };
  const extensionCandidatesByName = new Map<string, OsnovaSymbol[]>();
  const extensionsNamed = (name: string): OsnovaSymbol[] => {
    let found = extensionCandidatesByName.get(name);
    if (found === undefined) {
      found = (symbolsByName.get(name) ?? []).filter((symbol) => symbol.kind === "method" && symbol.parameters?.extension === true && files.get(symbol.file)?.language === "c_sharp");
      extensionCandidatesByName.set(name, found);
    }
    return found;
  };
  let unplacedNames: Set<string> | undefined;
  // A C# file whose extraction failed may declare an extension method of any name.
  let unreadFile: boolean | undefined;
  const unplacedExtension = (name: string): boolean => {
    unplacedNames ??= new Set([...files.values()].flatMap((card) => card.unplacedExtensions ?? []));
    unreadFile ??= [...files.values()].some((card) => card.language === "c_sharp" && unread(card));
    return unreadFile || unplacedNames.has(name);
  };
  const chooseExtension = (edge: OsnovaEdge): OsnovaEdge | undefined => {
    const written = edge.argumentTypes?.receiver;
    const count = edge.arguments;
    if (written === undefined || count === undefined || edge.kind !== "calls" || edge.toSymbol !== undefined) return undefined;
    const card = files.get(edge.fromFile);
    if (card?.language !== "c_sharp" || unplacedExtension(edge.toName)) return undefined;
    const enclosing = edge.fromSymbol.includes("#") ? localOfQualifiedName(edge.fromSymbol).split(".") : [];
    if (enclosing.length === 0) return undefined;
    const namespace = csharpNamespaceOf(card.path, enclosing[0]!);
    if (namespace === null) return undefined;
    const site: CsharpSite = { card, enclosing, namespace, line: edge.line };
    const receiver = csharpTypeAt(site, written);
    if (receiver === null || memberMayExist(receiver, edge.toName)) return undefined;
    const candidates = extensionsNamed(edge.toName).filter((symbol) => {
      const range = symbol.parameters!;
      return count + 1 >= range.min && (range.max === undefined || count + 1 <= range.max);
    });
    if (candidates.length === 0) return undefined;
    // An extension method's static class: a top-level type, so its namespace is known unless `?`.
    const classOf = (method: OsnovaSymbol): OsnovaSymbol | undefined => {
      const local = localOfQualifiedName(method.qualifiedName).split(".");
      return local.length === 2 ? declaredAs(method.file, qualifiedNameOf(method.file, local[0]!)).find(isHolder) : undefined;
    };
    const scope = csharpScopeOf();
    const usings = scope.byFile.get(card.path) ?? [];
    const parts = namespace.length === 0 ? [] : namespace.split(".");
    // Whether the caller is inside a type, in any of its partial declarations, nested types included.
    const callerInside = (type: OsnovaSymbol): boolean => {
      for (let depth = 1; depth <= enclosing.length; depth += 1) {
        const holder = declaredAs(card.path, qualifiedNameOf(card.path, enclosing.slice(0, depth).join("."))).find(isHolder);
        if (holder !== undefined && typeKey(holder) === typeKey(type)) return true;
      }
      return false;
    };
    // Each argument as written, resolved at the call site; the receiver is the first argument of an extension call.
    const argumentsAt = (edge.argumentTypes?.types ?? []).slice(0, count).map((written) => csharpArgumentAt(site, written));
    const named = (edge.argumentTypes?.types ?? []).some((written) => written === "#named");
    type Candidate = { method: OsnovaSymbol; imported: boolean; fits: boolean | null; parameters: (CsharpType | null)[]; defaults: number };
    // Whether candidate `m` is a better function member than `n` for these arguments: a better conversion for one
    // argument and none worse, or, with identical parameter types, no default argument substituted where `n` needs one.
    const betterMember = (m: Candidate, n: Candidate): boolean | null => {
      if (argumentsAt.some((argument) => argument === null)) return null;
      const all: CsharpArgument[] = [{ kind: "type", type: receiver }, ...argumentsAt.map((argument) => argument!)];
      let anyBetter = false;
      for (let i = 0; i < all.length; i += 1) {
        const p = m.parameters[i];
        const q = n.parameters[i];
        if (p === null || p === undefined || q === null || q === undefined) return null;
        const which = betterConversion(all[i]!, p, q);
        if (which === null) return null;
        if (which < 0) return false;
        if (which > 0) anyBetter = true;
      }
      if (anyBetter) return true;
      for (let i = 0; i < all.length; i += 1) if (sameCsharpType(m.parameters[i]!, n.parameters[i]!) !== true) return false;
      return m.defaults === 0 && n.defaults > 0;
    };
    let chosen: { method: OsnovaSymbol; imported: boolean } | undefined;
    let pending: OsnovaSymbol | undefined;
    // A method an inner level already offered (its namespace's own level, then a `using` of it further out) is no
    // new choice further out.
    const offered = new Set<OsnovaSymbol>();
    for (let depth = parts.length; depth >= 0; depth -= 1) {
      const level = parts.slice(0, depth).join(".");
      const scoped = usings.filter((using) => using.scope === level);
      if (depth > 0 && scoped.some((using) => site.line === using.from || site.line === using.to)) return undefined;
      const directives = depth === 0 ? [...usings.filter((using) => using.scope === ""), ...scope.global] : scoped.filter((using) => using.from < site.line && site.line < using.to);
      if (directives.some((using) => using.conditional || using.static)) return undefined;
      const imported = new Set(directives.map((using) => using.target));
      if (depth === 0) for (const name of IMPLICIT_USINGS) imported.add(name);
      // A .NET namespace this level imports may declare an extension method of the name.
      if ([...imported].some((name) => DOTNET_EXTENSIONS.get(name)?.has(edge.toName) === true)) return undefined;
      const here: Candidate[] = [];
      for (const method of candidates) {
        const owner = classOf(method);
        if (owner === undefined || owner.namespace === "?" || owner.conditional === true || method.conditional === true) return undefined;
        const home = owner.namespace ?? "";
        const local = home === level;
        if ((!local && !imported.has(home)) || offered.has(method)) continue;
        offered.add(method);
        const range = method.parameters!;
        // A private extension method is visible only inside its class.
        if (range.access === "private" && !callerInside(owner)) continue;
        const declaredSite: CsharpSite = { card: files.get(method.file)!, enclosing: localOfQualifiedName(owner.qualifiedName).split("."), namespace: home, line: method.span.startLine };
        const generic = range.generic ?? [];
        const target = range.receiver === undefined ? null : csharpTypeAt(declaredSite, range.receiver, generic);
        let fits = target === null ? null : receiverConverts(receiver, target);
        // A type argument to infer, a named argument, or a parameter list this did not read leaves the call unproven;
        // each written argument must convert to its parameter, and a `ref` or `out` parameter takes only an argument
        // written with that modifier.
        let unknown = fits === null || generic.length > 0 || named || range.written === undefined;
        const parameters: (CsharpType | null)[] = [target];
        let defaults = 0;
        for (let i = 0; fits !== false && i < Math.max(count, range.written?.length ?? 0); i += 1) {
          const entry = range.written?.[i];
          const part = entry === undefined ? null : /^(?:(ref|out|in|params) )?(.+?)(=?)$/u.exec(entry);
          // An argument beyond the parameters, or a `params` parameter, means the expanded form, which is not read.
          if (part === null || part[1] === "params") { unknown = true; break; }
          if (i >= count) {
            if (part[3] === "=") defaults += 1;
            else unknown = true;
            continue;
          }
          const written = edge.argumentTypes?.types[i] ?? null;
          if (written === "#ref") { unknown = true; parameters.push(null); continue; }
          if (part[1] === "ref" || part[1] === "out") { fits = false; break; }
          const p = part[2] === "?" ? null : csharpTypeAt(declaredSite, part[2]!, generic);
          const argument = argumentsAt[i] ?? null;
          if (p === null || p.kind === "parameter" || argument === null) { unknown = true; parameters.push(p); continue; }
          const fit = argumentFits(argument, p);
          if (fit === false) { fits = false; break; }
          if (fit === null) unknown = true;
          parameters.push(p);
        }
        if (fits !== false) here.push({ method, imported: !local, fits: unknown ? null : true, parameters, defaults });
      }
      if (here.length === 0) continue;
      if (pending !== undefined) return undefined;
      if (here.some((candidate) => candidate.fits !== true)) {
        // One candidate the index cannot prove applicable binds only when no other level offers one.
        if (here.length > 1) return undefined;
        pending = here[0]!.method;
        chosen = here[0]!;
        continue;
      }
      if (here.length === 1) { chosen = here[0]!; break; }
      // Several applicable: the one that is a better function member than every other, as the compiler picks it.
      let winner: Candidate | undefined;
      for (const candidate of here) {
        let beatsAll = true;
        for (const other of here) {
          if (other === candidate) continue;
          const better = betterMember(candidate, other);
          if (better === null) return undefined;
          if (!better) { beatsAll = false; break; }
        }
        if (beatsAll) { winner = candidate; break; }
      }
      if (winner === undefined) return undefined;
      chosen = winner;
      break;
    }
    if (chosen === undefined) return undefined;
    const method = chosen.method;
    const resolution: EdgeResolution = { status: "resolved", method: method.file === edge.fromFile ? "same-file-name" : chosen.imported ? "imported-file-name" : "lexical-definition" };
    // The binding stays: an incremental update rebuilds an unchanged file's raw edges from its resolved ones.
    const { overload: _previous, ...rest } = edge;
    const shared = declaredAs(method.file, method.qualifiedName).length > 1;
    return { ...rest, toSymbol: method.qualifiedName, toFile: method.file, evidence: { source: "syntax", resolution }, ...(shared ? { overload: { line: method.span.startLine, types: true } } : {}) };
  };
  const chooseOverload = (edge: OsnovaEdge): OsnovaEdge => {
    if (edge.constructs !== undefined) return chooseConstructor(edge);
    const local = withOverload(edge, declaredAs);
    if (edge.kind !== "calls" || edge.arguments === undefined || edge.toFile === undefined || edge.toSymbol === undefined) return local;
    const language = files.get(edge.toFile)?.language;
    const own = declaredAs(edge.toFile, edge.toSymbol);
    if ((language !== "java" && language !== "c_sharp") || own.length === 0) return local;
    const resolution = edge.evidence?.source === "syntax" ? edge.evidence.resolution : undefined;
    const holderName = resolution?.status === "resolved" && resolution.method === "receiver-hint" ? resolution.receiver.classSymbol
      : edge.toSymbol.slice(0, edge.toSymbol.lastIndexOf("."));
    const holder = declaredAs(holderName.slice(0, holderName.indexOf("#")), holderName).find(isHolder);
    if (holder === undefined) return local;
    const { levels, complete, interfacesClear } = overloadLevelsOf(holder, own[0]!.name);
    if (levels.some((level) => level.some((symbol) => symbol.parameters === undefined))) return local;
    const count = edge.arguments;
    // Java overrides a method by its parameter types, and @Override also marks an interface method's
    // implementation, so a Java override hides only a base declaration written with the same types.
    // A Java declaration whose written types prove nothing gets a key of its own, so it hides nothing.
    const keyOf = (symbol: OsnovaSymbol): string => {
      const range = symbol.parameters!;
      const types = language !== "java" ? "" : range.types === undefined || !javaNamesProven(symbol) ? `?${symbol.file}:${symbol.span.startLine}` : range.types.join(",");
      return `${range.min}:${range.max ?? ""}:${range.extension === true ? "e" : ""}:${types}`;
    };
    const pending = new Map<string, number>();
    const listed: OsnovaSymbol[] = [];
    let slots = 0;
    for (const level of levels) {
      const groups = new Map<string, OsnovaSymbol[]>();
      for (const symbol of level) {
        if (!accepts(symbol.parameters!, count)) continue;
        const key = keyOf(symbol);
        groups.set(key, [...(groups.get(key) ?? []), symbol]);
      }
      for (const [key, group] of groups) {
        const hidden = Math.min(pending.get(key) ?? 0, group.length);
        slots += group.length - hidden;
        if (hidden < group.length) listed.push(...group);
        // Every override in the group, hidden or not, still hides one declaration further up.
        pending.set(key, (pending.get(key) ?? 0) - hidden + group.filter((symbol) => symbol.parameters!.overrides === true).length);
      }
    }
    const isOwn = (symbol: OsnovaSymbol): boolean => symbol.file === edge.toFile && symbol.qualifiedName === edge.toSymbol;
    const elsewhere = listed.filter((symbol) => !isOwn(symbol));
    // When every level is known, the written argument types may single out one of several declarations that take the count.
    const typed = language === "java" && complete && interfacesClear === true && slots >= 2 ? chooseJavaByTypes(edge, listed) : undefined;
    if (typed !== undefined) {
      const { overload: _discarded, ...plain } = edge;
      return isOwn(typed) ? { ...plain, overload: { line: typed.span.startLine, types: true } }
        : { ...plain, toSymbol: typed.qualifiedName, toFile: typed.file, overload: { line: typed.span.startLine, from: edge.toSymbol, types: true } };
    }
    // Declarations above an unidentified base can only add choices: two found already are enough to refuse,
    // and one found is not proven the only one, so a line chosen in the target's file is withdrawn.
    if (!complete && slots < 2) return local.overload !== undefined && "line" in local.overload ? { ...local, overload: { candidates: [local.overload.line] } } : local;
    if (elsewhere.length === 0) return local;
    const { overload: _previous, ...rest } = edge;
    if (slots === 1 && listed.length === 1) {
      const chosen = listed[0]!;
      return { ...rest, toSymbol: chosen.qualifiedName, toFile: chosen.file, overload: { line: chosen.span.startLine, from: edge.toSymbol } };
    }
    const candidates = listed.filter(isOwn).map((symbol) => symbol.span.startLine).sort((a, b) => a - b);
    const sites = elsewhere.map((symbol) => ({ file: symbol.file, line: symbol.span.startLine }))
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
    return { ...rest, overload: { candidates, elsewhere: sites } };
  };

  const edges: OsnovaEdge[] = [];
  // A reused edge was chosen against the same declarations (any change to them re-resolves every file).
  const reused = new Set<OsnovaEdge>();
  for (const fromFile of [...rawEdges.keys()].sort()) {
    if (reusable !== undefined && reuse !== undefined && !reuse.resolve.has(fromFile)) {
      for (const edge of reusable.get(fromFile) ?? []) { edges.push(edge); reused.add(edge); }
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
        let resolution: EdgeResolution = { status: "unresolved", reason: binding.kind === "blocked" && binding.reason === "inline-handler" ? "route-handler-inline" : binding.kind === "blocked" && binding.reason === "wrapped-handler" ? "route-handler-wrapped"
          : binding.kind === "instance" || (binding.kind === "blocked" && binding.reason === "unknown-receiver") ? "receiver-unresolved"
          : binding.kind === "blocked" && binding.reason === "unbound" && !(languageFamily(card.language) === languageFamily("typescript") && ambientGlobals.has(raw.toName)) ? "unbound-global" : "binding-blocked" };
        let exportResult: ExportResult | undefined;
        if (reference.kind === "import") {
          const target = resolveImportTarget(card.language, fromFile, reference.source, knownFiles, context);
          if (target === undefined) resolution = unresolvedImport(card.language, fromFile, reference.source);
          else {
            exportResult = exported(target, reference.importedName, inlinePath(card.language, fromFile, reference.source));
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
          candidates = [...declaredLocal(fromFile, reference.name, card.language === "rust" ? moduleOf(fromFile, fromSymbol) : "")];
          // A same-file function named like a builtin (`export function string()`) is not the type a receiver carries.
          if (binding.kind === "member" && BUILTIN_TYPES.has(reference.name) && !candidates.some(isHolder)) candidates = [];
          // The file declares this name in more than one scope, and the index keeps one record per
          // qualified name, so no edge can name the declaration this site sees. Refuse instead.
          if (candidates.some((symbol) => symbol.shadowed === true)) {
            // A value reference is recorded only when it names an indexed callable or class.
            if (raw.kind === "references") continue;
            edges.push({
              kind: raw.kind, fromFile, fromSymbol, toName: raw.toName, line: raw.line, binding,
              evidence: { source: "syntax", resolution: { status: "unresolved", reason: "shadowed-declaration" } },
              ...(raw.route === undefined ? {} : { route: raw.route }),
              ...(raw.arguments === undefined ? {} : { arguments: raw.arguments }), ...(raw.argumentTypes === undefined ? {} : { argumentTypes: raw.argumentTypes }),
              ...(raw.constructs === undefined ? {} : { constructs: raw.constructs }),
            });
            continue;
          }
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
          // An interface cannot be constructed: `new X()` on a name merged with a constant runs the constant's construct
          // signature, whose instance type the index does not read.
          if (owner !== undefined && basis === "constructor" && declarationsOf(owner).every((declaration) => declaration.kind === "interface")) owner = undefined;
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
              symbol.qualifiedName.slice(symbol.qualifiedName.indexOf("#") + 1) === local && (card.language !== "go" || (path.posix.dirname(symbol.file) === holderDir && sameGoPackage(files.get(symbol.file)!, files.get(holder.file)!))));
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
            // A persisted field table is a plain object, so `this.constructor.name` must not read Object.prototype.
            const own = declarations.flatMap((declaration) => { const record = declaration[table]; const binding = record !== undefined && Object.hasOwn(record, member) ? record[member] : undefined; return binding === undefined ? [] : [{ file: declaration.file, binding }]; });
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
            const found = exported(target, ref.importedName, inlinePath(card.language, fromFile, ref.source));
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
        if (raw.kind === "extends" || raw.kind === "implements") candidates = candidates.filter((symbol) => HERITAGE_KINDS.has(symbol.kind));
        if (raw.kind === "routes") candidates = candidates.filter((symbol) => ROUTE_TARGET_KINDS.has(symbol.kind));
        const names = [...new Set(candidates.map((symbol) => symbol.qualifiedName))].sort();
        const resolved = names.length === 1 && candidates[0]!.shadowed !== true ? candidates[0] : undefined;
        if (names.length > 1) resolution = { status: "ambiguous", candidates: names };
        // The member reached is one of several declarations of its name in one scope (cfg-gated Rust twins in an
        // impl): the index keeps one record, so no edge can name the one a build compiles.
        else if (names.length === 1 && candidates[0]!.shadowed === true) resolution = { status: "unresolved", reason: "shadowed-declaration" };
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
          ...(raw.route === undefined ? {} : { route: raw.route }),
          ...(raw.arguments === undefined ? {} : { arguments: raw.arguments }), ...(raw.argumentTypes === undefined ? {} : { argumentTypes: raw.argumentTypes }),
          ...(raw.constructs === undefined ? {} : { constructs: raw.constructs }),
        });
        continue;
      }
      if (raw.constructs !== undefined && (card.language === "java" || card.language === "c_sharp")) {
        const found = card.language === "java" ? javaCreatedType(card, fromSymbol, raw.toName) : csharpCreatedType(card, fromSymbol, raw.toName, raw.line);
        // Two types declared under one qualified name in one file (local classes in different blocks of a method, or
        // partial types of different namespaces or arities) are not one type, and the index cannot tell them apart. A
        // C# delegate's constructor is not indexed, and the name it shares may also hold another type's constructors.
        const typeFound: CreatedType = found.status === "resolved" && (found.type.kind === "type" || found.type.unparsedHeader === true || (found.type.conditional === true && csharpContested(found.type.name)) || !singleType(found.type) ||
          constructorsOf(found.type).constructors.some((constructor) => constructor.conditional === true)) ? unknownType : found;
        const target = typeFound.status === "resolved" ? constructedBy(typeFound.type, raw.constructs) : undefined;
        const args = { ...(raw.arguments === undefined ? {} : { arguments: raw.arguments }), ...(raw.argumentTypes === undefined ? {} : { argumentTypes: raw.argumentTypes }), constructs: raw.constructs };
        const evidence = { source: "syntax" as const, resolution: typeFound.status === "resolved" ? { status: "resolved" as const, method: typeFound.method } : typeFound };
        edges.push(target === undefined
          ? { kind: raw.kind, fromFile, fromSymbol, toName: raw.toName, line: raw.line, evidence, ...args }
          : { kind: raw.kind, fromFile, fromSymbol, toName: raw.toName, line: raw.line, toSymbol: target.qualifiedName, toFile: target.file, evidence, ...args });
        continue;
      }
      const lookupName = raw.toName.includes(".")
        ? (raw.toName.split(".").pop() ?? raw.toName)
        : raw.toName;
      // A plain Rust name never names an impl method or a variant: `Ok(x)` is the prelude's, not `ParseResult::Ok`,
      // however unique that is. A function nested in a function or method (`fn imp` inside `fn is_readable_stdin`) still counts.
      // A method of an impl for a type outside the index (`impl From<X> for std::io::Error`) has no declared parent
      // at all; it is a member of that foreign type, never a plain name. An inline module is a namespace, not a
      // holder: its items are plain names inside it, which `moduleOf` sorts out below.
      // Only the immediate parent decides: a trait impl's methods sit under the undeclared `Type.Trait`, and an
      // outer declaration of the same name (an associated `type Error` leaked to the file root) says nothing.
      const memberOfHolder = (symbol: OsnovaSymbol): boolean => {
        const parts = symbol.qualifiedName.slice(symbol.qualifiedName.indexOf("#") + 1).split(".");
        if (parts.length < 2) return false;
        const parent = declaredAs(symbol.file, `${symbol.file}#${parts.slice(0, -1).join(".")}`)[0];
        if (parent === undefined) return true;
        return parent.kind === "module" ? false : isHolder(parent);
      };
      // A plain Go name never names a method either, and it is declared by the caller's own package (the files of its
      // directory with its package clause) before any other file.
      const plainGo = card.language === "go" && !raw.toName.includes(".");
      const plainRust = card.language === "rust" && !raw.toName.includes(".");
      // An item declared inside a function's body is in scope only in its block.
      const nestedVisible = (symbol: OsnovaSymbol): boolean => {
        const local = symbol.qualifiedName.slice(symbol.qualifiedName.indexOf("#") + 1);
        const parentLocal = local.includes(".") ? local.slice(0, local.lastIndexOf(".")) : "";
        if (parentLocal === "") return true;
        const parent = declaredAs(symbol.file, `${symbol.file}#${parentLocal}`)[0];
        // The adapter binds a call to an item of an enclosing block exactly; by name, such an item is never in scope.
        return parent === undefined || (parent.kind !== "function" && parent.kind !== "method");
      };
      // An item of an inline module is in scope only inside that module; from anywhere else it needs a path. A
      // caller inside the module sees the module's item before the file's.
      const callerModule = plainRust ? moduleOf(fromFile, fromSymbol) : "";
      const candidates = (symbolsByName.get(lookupName) ?? []).filter((symbol) =>
        languageFamily(files.get(symbol.file)?.language) === languageFamily(card.language) &&
        (card.language !== "rust" || raw.toName.includes(".") || !memberOfHolder(symbol)) &&
        (!plainRust || nestedVisible(symbol)) &&
        (!plainRust || (symbol.kind !== "module" && (callerModule === ""
          ? moduleOf(symbol.file, symbol.qualifiedName) === ""
          : symbol.file === fromFile && moduleOf(symbol.file, symbol.qualifiedName) === callerModule))) &&
        (!plainGo || symbol.kind !== "method"));
      const sameModule = plainRust && callerModule !== "" ? candidates.filter((symbol) => symbol.file === fromFile && moduleOf(symbol.file, symbol.qualifiedName) === callerModule) : [];
      const sameFile = sameModule.length > 0 ? sameModule : candidates.filter((symbol) => symbol.file === fromFile);
      const samePackage = plainGo ? candidates.filter((symbol) => {
        const other = files.get(symbol.file);
        return other !== undefined && path.posix.dirname(symbol.file) === path.posix.dirname(fromFile) && sameGoPackage(other, card);
      }) : [];
      // A declaration in another file built only in some configurations may not be compiled with the caller, which then
      // reaches a builtin or a declaration elsewhere; the index cannot tell which.
      const conditionalPackage = sameFile.length === 0 && samePackage.some((symbol) => goHeaderOf(files.get(symbol.file)!).constrained);
      const imported = candidates.filter((symbol) => importTargets.includes(symbol.file));
      const preferred = sameFile.length > 0 ? sameFile : samePackage.length > 0 ? samePackage : imported.length > 0 ? imported : candidates;
      const names = [...new Set(preferred.map((symbol) => symbol.qualifiedName))].sort();
      // The chosen declaration is one of several the file declares for the name (cfg-gated Rust twins): the index
      // keeps one record per qualified name, so no edge can name the one a build compiles.
      const shadowedTarget = names.length === 1 && preferred[0]!.shadowed === true;
      const resolved = names.length === 1 && !conditionalPackage && !shadowedTarget ? preferred[0] : undefined;
      const resolution: EdgeResolution = conditionalPackage ? { status: "unresolved", reason: "binding-blocked" }
        : shadowedTarget ? { status: "unresolved", reason: "shadowed-declaration" }
        : names.length > 1
        ? { status: "ambiguous", candidates: names }
        // Go, Rust, Java and C# bind plain names without an import statement, so a name no indexed file of
        // the family defines is a builtin or a standard-library name: external, like an unbound global.
        : resolved === undefined ? { status: "unresolved", reason: TYPED_FAMILY.has(card.language) && candidates.length === 0 ? "unbound-global" : "no-matching-symbol" }
          : { status: "resolved", method: sameFile.length > 0 ? "same-file-name" : samePackage.length > 0 ? "lexical-definition" : imported.length > 0 ? "imported-file-name" : "unique-name" };
      const args = { ...(raw.arguments === undefined ? {} : { arguments: raw.arguments }), ...(raw.argumentTypes === undefined ? {} : { argumentTypes: raw.argumentTypes }), ...(raw.constructs === undefined ? {} : { constructs: raw.constructs }) };
      edges.push(
        resolved === undefined
          ? { kind: raw.kind, fromFile, fromSymbol, toName: raw.toName, line: raw.line, evidence: { source: "syntax", resolution }, ...args }
          : {
              kind: raw.kind,
              fromFile,
              fromSymbol,
              toName: raw.toName,
              line: raw.line,
              toSymbol: resolved.qualifiedName,
              toFile: resolved.file,
              evidence: { source: "syntax", resolution },
              ...args,
            },
      );
    }
  }
  return edges.map((edge) => reused.has(edge) ? edge : chooseExtension(edge) ?? chooseOverload(edge));
}

// Per-card facts read from source text. A card is immutable and an incremental update keeps the cards of
// unchanged files, so these survive across updates.
const codeCache = new WeakMap<FileCard, string>();
const javaImportCache = new WeakMap<FileCard, { single: Map<string, string>; onDemand: string[]; staticSingle: Set<string>; staticOnDemand: boolean }>();
// Java source with comments, string and character literals and text blocks blanked, so a keyword search finds
// only code. A backslash escapes the next character in each literal, a text block's closing quotes included.
function javaCodeOnly(text: string): string {
  const out: string[] = [];
  let from = 0;
  let i = 0;
  const literalEnd = (start: number, quote: string, block: boolean): number => {
    let j = start;
    while (j < text.length) {
      if (text[j] === "\\") { j += 2; continue; }
      if (block ? text.startsWith('"""', j) : text[j] === quote) return j + (block ? 3 : 1);
      if (!block && text[j] === "\n") return j;
      j += 1;
    }
    return text.length;
  };
  while (i < text.length) {
    const c = text.charCodeAt(i);
    // `/`, `"` and `'` start every construct blanked here; anything else is copied in runs.
    if (c !== 47 && c !== 34 && c !== 39) { i += 1; continue; }
    const next = text[i + 1];
    let end: number;
    if (c === 47 && next === "/") { end = text.indexOf("\n", i); if (end < 0) end = text.length; }
    else if (c === 47 && next === "*") { end = text.indexOf("*/", i + 2); end = end < 0 ? text.length : end + 2; }
    else if (c === 34 && text.startsWith('"""', i)) end = literalEnd(i + 3, '"', true);
    else if (c === 34 || c === 39) end = literalEnd(i + 1, text[i]!, false);
    else { i += 1; continue; }
    out.push(text.slice(from, i), text.slice(i, end).replace(/[^\n]/g, " "));
    from = i = end;
  }
  out.push(text.slice(from));
  return out.join("");
}

function accepts(range: ParameterRange, count: number): boolean {
  const fits = (n: number): boolean => n >= range.min && (range.max === undefined || n <= range.max);
  return fits(count) || (range.extension === true && fits(count + 1));
}

// The index keeps one symbol per qualified name, so every overload of a method shares the edge's target.
// The call's argument count names the declaration it binds when exactly one accepts that many.
function withOverload(edge: OsnovaEdge, declaredAs: (file: string, qualifiedName: string) => readonly OsnovaSymbol[]): OsnovaEdge {
  const ranges = edge.kind !== "calls" || edge.arguments === undefined || edge.toFile === undefined || edge.toSymbol === undefined ? []
    : declaredAs(edge.toFile, edge.toSymbol).flatMap((symbol) => symbol.parameters === undefined ? [] : [{ line: symbol.span.startLine, range: symbol.parameters }]);
  const count = edge.arguments ?? 0;
  const lines = ranges.filter((entry) => accepts(entry.range, count)).map((entry) => entry.line).sort((a, b) => a - b);
  const overload = ranges.length === 0 || (ranges.length === 1 && lines.length === 1) ? undefined
    : lines.length === 1 ? { line: lines[0]! } : { candidates: lines };
  if (overload === undefined && edge.overload === undefined) return edge;
  const { overload: _previous, ...rest } = edge;
  return overload === undefined ? rest : { ...rest, overload };
}
