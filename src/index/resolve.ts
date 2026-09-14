import path from "node:path";
import type { CardLanguage, EdgeResolution, ExportHop, FileCard, OsnovaEdge, OsnovaSymbol } from "../types.js";
import { qualifiedNameOf } from "./indexImpl.js";
import type { RawEdgeItem } from "./indexImpl.js";

const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

function languageFamily(language: CardLanguage | undefined): string | undefined {
  return language === "typescript" || language === "tsx" || language === "javascript" ? "javascript" : language;
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
  const modulePath = up > 0 ? path.posix.join(baseDir, ...parts) : parts.join("/");
  const init = path.posix.join(modulePath, "__init__.py");
  if (knownFiles.has(init)) return init;
  if (knownFiles.has(`${modulePath}.py`)) return `${modulePath}.py`;
  return undefined;
}

function resolveImportTarget(
  language: string,
  fromFile: string,
  spec: string,
  knownFiles: ReadonlySet<string>,
): string | undefined {
  if (language === "typescript" || language === "tsx" || language === "javascript") {
    if (!spec.startsWith("./") && !spec.startsWith("../")) return undefined;
    return resolveNodeSpecifier(fromFile, spec, knownFiles);
  }
  if (language === "python") {
    return resolvePythonSpecifier(fromFile, spec, knownFiles);
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
  interface ExportResult {
    symbols: Map<string, OsnovaSymbol>;
    routes: Map<string, readonly ExportHop[]>;
    incomplete: boolean;
    cycle: boolean;
  }
  const exportCache = new Map<string, ExportResult>();
  const exported = (file: string, name: string): ExportResult => {
    const key = JSON.stringify([file, name]);
    const cached = exportCache.get(key);
    if (cached !== undefined) return cached;
    const result: ExportResult = { symbols: new Map(), routes: new Map(), incomplete: false, cycle: false };
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
      const named = links.filter((link) => link.kind === "named" && link.exportedName === currentName);
      const next = direct.length > 0 || named.length > 0 ? named
        : currentName === "default" ? [] : links.filter((link) => link.kind === "star");
      for (const symbol of direct) {
        if (!result.symbols.has(symbol.qualifiedName)) {
          result.symbols.set(symbol.qualifiedName, symbol);
          result.routes.set(symbol.qualifiedName, via);
        }
      }
      active.add(state);
      for (const link of next) {
        if (link.kind === "blocked") continue;
        const target = resolveImportTarget(card.language, currentFile, link.source, knownFiles);
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
  const importTargetsByFile = new Map<string, string[]>();
  for (const fromFile of [...rawEdges.keys()].sort()) {
    const raws = rawEdges.get(fromFile);
    const card = files.get(fromFile);
    if (raws === undefined || card === undefined) continue;
    const targets: string[] = [];
    for (const raw of raws) {
      if (raw.kind !== "imports") continue;
      const target = resolveImportTarget(card.language, fromFile, raw.toName, knownFiles);
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
        const toFile = resolveImportTarget(card.language, fromFile, raw.toName, knownFiles);
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
        let candidates: readonly OsnovaSymbol[] = [];
        let resolution: EdgeResolution = { status: "unresolved", reason: "binding-blocked" };
        let exportResult: ExportResult | undefined;
        if (binding.kind === "import") {
          const target = resolveImportTarget(card.language, fromFile, binding.source, knownFiles);
          if (target === undefined) resolution = { status: "unresolved", reason: "import-target-unresolved" };
          else {
            exportResult = exported(target, binding.importedName);
            if (exportResult.incomplete) resolution = { status: "unresolved", reason: "re-export-incomplete" };
            else {
              candidates = [...exportResult.symbols.values()].filter((symbol) =>
                languageFamily(files.get(symbol.file)?.language) === languageFamily(card.language) &&
                (raw.kind !== "calls" || (symbol.kind !== "interface" && symbol.kind !== "type")));
              resolution = candidates.length === 0 && exportResult.cycle
                ? { status: "unresolved", reason: "re-export-cycle" }
                : { status: "resolved", method: "import-binding" };
            }
          }
        } else if (binding.kind === "local") {
          candidates = card.symbols.filter((symbol) => symbol.qualifiedName === qualifiedNameOf(fromFile, binding.name));
          resolution = { status: "resolved", method: "lexical-definition" };
        }
        const names = [...new Set(candidates.map((symbol) => symbol.qualifiedName))].sort();
        const resolved = names.length === 1 ? candidates[0] : undefined;
        if (names.length > 1) resolution = { status: "ambiguous", candidates: names };
        else if (resolved === undefined && resolution.status === "resolved") resolution = { status: "unresolved", reason: "bound-symbol-missing" };
        const via = resolved === undefined ? undefined : exportResult?.routes.get(resolved.qualifiedName);
        if (via !== undefined && via.length > 0) resolution = { status: "resolved", method: "re-export-binding", via };
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
