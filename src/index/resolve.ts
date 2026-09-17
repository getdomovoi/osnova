import path from "node:path";
import type { Callee, CardLanguage, EdgeResolution, ExportHop, FileCard, OsnovaEdge, OsnovaSymbol, ReceiverBasis, ReceiverMode, ReceiverOwner, SymbolBinding } from "../types.js";
import { qualifiedNameOf } from "./indexImpl.js";
import type { RawEdgeItem } from "./indexImpl.js";

const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

function languageFamily(language: CardLanguage | undefined): string | undefined {
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
export interface WorkspaceContext { readonly packages: ReadonlyMap<string, PackageEntry | null>; readonly pythonRoots: readonly PythonRoot[] }

export function workspaceContext(files: ReadonlyMap<string, FileCard>): WorkspaceContext {
  const packages = new Map<string, PackageEntry | null>();
  const pythonRoots = new Map<string, PythonRoot>([["\0", { dir: "", manifest: "" }]]);
  for (const [file, card] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
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
    } else if (base === "pyproject.toml" || base === "setup.py" || base === "setup.cfg") {
      pythonRoots.set(`${dir}\0${dir}`, { dir, manifest: dir });
      const src = dir === "" ? "src" : `${dir}/src`;
      for (const known of files.keys()) if (known.startsWith(`${src}/`)) { pythonRoots.set(`${src}\0${dir}`, { dir: src, manifest: dir }); break; }
    }
  }
  return { packages, pythonRoots: [...pythonRoots.values()].sort((a, b) => a.manifest < b.manifest ? -1 : a.manifest > b.manifest ? 1 : a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0) };
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
  return undefined;
}

export interface ResolutionInput {
  readonly root: string;
  readonly files: ReadonlyMap<string, FileCard>;
  readonly rawEdges: ReadonlyMap<string, readonly RawEdgeItem[]>;
}

export function resolveEdges(input: ResolutionInput): OsnovaEdge[] {
  const { files, rawEdges } = input;

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

  const knownFiles = new Set(files.keys());
  const context = workspaceContext(files);
  interface ExportResult {
    symbols: Map<string, OsnovaSymbol>;
    routes: Map<string, readonly ExportHop[]>;
    namespaces: Array<{ file: string; via: readonly ExportHop[] }>;
    incomplete: boolean;
    cycle: boolean;
  }
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
      const links = card.reExports ?? [];
      if (links.some((link) => link.kind === "blocked" && (link.exportedName === currentName || link.exportedName === "*"))) {
        result.incomplete = true;
        return;
      }
      const direct = card.symbols.filter((symbol) => symbol.exportedNames?.includes(currentName));
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
        if (!result.symbols.has(symbol.qualifiedName)) {
          result.symbols.set(symbol.qualifiedName, symbol);
          result.routes.set(symbol.qualifiedName, via);
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

  const edges: OsnovaEdge[] = [];
  for (const fromFile of [...rawEdges.keys()].sort()) {
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
                evidence: { source: "syntax", resolution: { status: "unresolved", reason: "import-target-unresolved" } } }
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
          if (target === undefined) resolution = { status: "unresolved", reason: "import-target-unresolved" };
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
          candidates = card.symbols.filter((symbol) => symbol.qualifiedName === qualifiedNameOf(fromFile, reference.name));
          resolution = { status: "resolved", method: "lexical-definition" };
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
          const owners = candidates.filter((symbol) => symbol.kind === "class" || symbol.kind === "interface" || symbol.kind === "module");
          owner = new Set(owners.map((symbol) => symbol.qualifiedName)).size === 1 ? owners[0] : undefined;
          const membersOf = (holder: OsnovaSymbol, member: string = binding.member): OsnovaSymbol[] => (files.get(holder.file)?.symbols ?? []).filter((symbol) =>
            (symbol.kind === "method" || symbol.kind === "function") && symbol.qualifiedName === `${holder.qualifiedName}.${member}`);
          // Walk declared heritage when the owner itself lacks the member. Any base that cannot be
          // identified, a cycle, an own non-method field of that name, or two base chains that
          // disagree leaves the member unresolved rather than guessed.
          const declarationsOf = (holder: OsnovaSymbol): OsnovaSymbol[] => (files.get(holder.file)?.symbols ?? []).filter((symbol) =>
            symbol.qualifiedName === holder.qualifiedName && (symbol.kind === "class" || symbol.kind === "interface" || symbol.kind === "module"));
          const basesOf = (holder: OsnovaSymbol, base: SymbolBinding): OsnovaSymbol[] | null => {
            const holderCard = files.get(holder.file);
            if (holderCard === undefined) return null;
            let bases: OsnovaSymbol[] = [];
            if (base.kind === "local") bases = holderCard.symbols.filter((symbol) => symbol.qualifiedName === qualifiedNameOf(holder.file, base.name));
            else {
              const target = resolveImportTarget(holderCard.language, holder.file, base.source, knownFiles, context);
              if (target === undefined) return null;
              const found = exported(target, base.importedName);
              if (found.incomplete) return null;
              bases = [...found.symbols.values()];
            }
            const holders = bases.filter((symbol) => symbol.kind === "class" || symbol.kind === "interface");
            return holders.length === 0 || new Set(holders.map((symbol) => symbol.qualifiedName)).size !== 1 ? null : [holders[0]!];
          };
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
          const symbolsFor = (file: string, ref: SymbolBinding): OsnovaSymbol[] | null => {
            const holderCard = files.get(file);
            if (holderCard === undefined) return null;
            if (ref.kind === "local") return holderCard.symbols.filter((symbol) => symbol.qualifiedName === qualifiedNameOf(file, ref.name));
            const target = resolveImportTarget(holderCard.language, file, ref.source, knownFiles, context);
            if (target === undefined) return null;
            const found = exported(target, ref.importedName);
            return found.incomplete ? null : [...found.symbols.values()];
          };
          const unique = (symbols: OsnovaSymbol[] | null): OsnovaSymbol | undefined =>
            symbols !== null && symbols.length > 0 && new Set(symbols.map((symbol) => symbol.qualifiedName)).size === 1 ? symbols[0] : undefined;
          const returnKey = (symbol: OsnovaSymbol): string => JSON.stringify(symbol.returns ?? null);
          // Every declaration sharing the qualified name (overloads) must agree on the return binding.
          const holderOfCallables = (callables: OsnovaSymbol[] | null, receiver: OsnovaSymbol | undefined, mode: ReceiverMode | undefined): OsnovaSymbol | undefined => {
            if (callables === null || callables.length === 0) return undefined;
            const first = callables[0]!;
            if (callables.some((symbol) => symbol.qualifiedName !== first.qualifiedName)) return undefined;
            if (first.kind === "class" || first.kind === "interface") return card.language === "python" && receiver === undefined ? first : undefined;
            if (first.kind !== "function" && first.kind !== "method") return undefined;
            if (callables.some((symbol) => symbol.returns === undefined || returnKey(symbol) !== returnKey(first))) return undefined;
            if (first.kind === "method") {
              if (callables.some((symbol) => symbol.memberKind === undefined || symbol.memberKind === "property" || symbol.memberKind === "unknown")) return undefined;
              if (card.language !== "python" && mode !== undefined && callables.some((symbol) => (mode === "class" ? symbol.memberKind !== "static" : symbol.memberKind !== "instance"))) return undefined;
            }
            const returns = first.returns!;
            if (returns.kind === "this") return receiver;
            return unique(symbolsFor(first.file, returns)?.filter((symbol) => symbol.kind === "class" || symbol.kind === "interface") ?? null);
          };
          const holderOf = (ref: ReceiverOwner, depth: number): OsnovaSymbol | undefined => {
            if (depth > 6) return undefined;
            if (ref.kind !== "return") return unique(symbolsFor(fromFile, ref)?.filter((symbol) => symbol.kind === "class" || symbol.kind === "interface" || symbol.kind === "module") ?? null);
            const of: Callee = ref.of;
            if (of.kind === "local" || of.kind === "import") return holderOfCallables(symbolsFor(fromFile, of)?.filter((symbol) => ["class", "interface", "function", "method"].includes(symbol.kind)) ?? null, undefined, undefined);
            const holder = holderOf(of.owner, depth + 1);
            if (holder === undefined) return undefined;
            return holderOfCallables(inherited(holder, 0, new Set([holder.qualifiedName]), of.member), holder, of.mode);
          };
          const rootImportUnresolved = (ref: ReceiverOwner | Callee, depth = 0): boolean => {
            if (depth > 8) return false;
            if (ref.kind === "import") return resolveImportTarget(card.language, fromFile, ref.source, knownFiles, context) === undefined;
            if (ref.kind === "return") return rootImportUnresolved(ref.of, depth + 1);
            if (ref.kind === "method") return rootImportUnresolved(ref.owner, depth + 1);
            return false;
          };
          if (binding.owner.kind === "return") {
            owner = holderOf(binding.owner, 0); basis = "return";
            if (owner === undefined && rootImportUnresolved(binding.owner)) resolution = { status: "unresolved", reason: "import-target-unresolved" };
          }
          else if (owner === undefined && card.language === "python" && binding.basis === "constructor") {
            owner = holderOfCallables(candidates.filter((symbol) => symbol.kind === "function" || symbol.kind === "method"), undefined, undefined);
            if (owner !== undefined) basis = "return";
          }
          const members: OsnovaSymbol[] = owner === undefined ? [] : inherited(owner, 0, new Set([owner.qualifiedName])) ?? [];
          // A namespace function behaves like a static member: reachable through the namespace name, never through an instance.
          const effectiveKind = (symbol: OsnovaSymbol) => symbol.kind === "function" ? "static" : symbol.memberKind;
          const kinds = new Set(members.map(effectiveKind));
          candidates = kinds.size > 1 ? [] : members.filter((symbol) => {
            const kind = effectiveKind(symbol);
            if (kind === undefined || kind === "unknown" || kind === "property") return false;
            if (card.language === "python") return true;
            return binding.mode === "class" ? kind === "static" : kind === "instance";
          });
          if (owner !== undefined && candidates.length > 0) {
            resolution = { status: "resolved", method: "receiver-hint", receiver: { classSymbol: owner.qualifiedName, mode: binding.mode, basis } };
          } else if (resolution.status === "resolved" || reference.kind === "local" || (reference.kind === "return" && resolution.reason !== "import-target-unresolved")) {
            resolution = { status: "unresolved", reason: "receiver-unresolved" };
          }
        }
        const names = [...new Set(candidates.map((symbol) => symbol.qualifiedName))].sort();
        const resolved = names.length === 1 ? candidates[0] : undefined;
        if (names.length > 1) resolution = { status: "ambiguous", candidates: names };
        else if (resolved === undefined && resolution.status === "resolved") resolution = { status: "unresolved", reason: "bound-symbol-missing" };
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
      const candidates = (symbolsByName.get(lookupName) ?? []).filter((symbol) =>
        languageFamily(files.get(symbol.file)?.language) === languageFamily(card.language));
      const sameFile = candidates.filter((symbol) => symbol.file === fromFile);
      const imported = candidates.filter((symbol) => importTargets.includes(symbol.file));
      const preferred = sameFile.length > 0 ? sameFile : imported.length > 0 ? imported : candidates;
      const names = [...new Set(preferred.map((symbol) => symbol.qualifiedName))].sort();
      const resolved = names.length === 1 ? preferred[0] : undefined;
      const resolution: EdgeResolution = names.length > 1
        ? { status: "ambiguous", candidates: names }
        : resolved === undefined ? { status: "unresolved", reason: "no-matching-symbol" }
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
