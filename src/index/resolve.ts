import path from "node:path";
import type { FileCard, OsnovaEdge, OsnovaSymbol } from "../types.js";
import { qualifiedNameOf } from "./indexImpl.js";
import type { RawEdgeItem } from "./indexImpl.js";

const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

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
    baseDir = path.posix.dirname(baseDir);
  }
  const parts = rest.length > 0 ? rest.split(".") : [];
  if (up >= 1) {
    for (let keep = parts.length; keep >= 0; keep -= 1) {
      const dirParts = [...baseDir.split("/").filter((p) => p.length > 0), ...parts.slice(0, keep)];
      const tail = parts.slice(keep);
      if (tail.length === 0) continue;
      const modulePath = [...dirParts, tail.join("/")].join("/");
      if (knownFiles.has(`${modulePath}.py`)) return `${modulePath}.py`;
      if (knownFiles.has(`${modulePath}/__init__.py`)) return `${modulePath}/__init__.py`;
    }
    if (parts.length === 0) {
      if (knownFiles.has(`${baseDir}/__init__.py`)) return `${baseDir}/__init__.py`;
    }
    return undefined;
  }
  const modulePath = parts.join("/");
  if (knownFiles.has(`${modulePath}.py`)) return `${modulePath}.py`;
  if (knownFiles.has(`${modulePath}/__init__.py`)) return `${modulePath}/__init__.py`;
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
            ? { kind: "imports", fromFile, fromSymbol, toName: raw.toName, line: raw.line }
            : { kind: "imports", fromFile, fromSymbol, toName: raw.toName, line: raw.line, toFile },
        );
        continue;
      }
      const lookupName = raw.toName.includes(".")
        ? (raw.toName.split(".").pop() ?? raw.toName)
        : raw.toName;
      const candidates = symbolsByName.get(lookupName);
      let resolved: OsnovaSymbol | undefined;
      if (candidates !== undefined) {
        resolved =
          candidates.find((c) => c.file === fromFile) ??
          candidates
            .filter((c) => importTargets.includes(c.file))
            .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))[0] ??
          (candidates.length === 1 ? candidates[0] : undefined);
      }
      edges.push(
        resolved === undefined
          ? { kind: raw.kind, fromFile, fromSymbol, toName: raw.toName, line: raw.line }
          : {
              kind: raw.kind,
              fromFile,
              fromSymbol,
              toName: raw.toName,
              line: raw.line,
              toSymbol: resolved.qualifiedName,
              toFile: resolved.file,
            },
      );
    }
  }
  return edges;
}
