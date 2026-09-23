import path from "node:path";
import type { FileCard } from "../types.js";

const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
const CONFIG_NAME = /^(?:ts|js)config[^/]*\.json$/;

export function isTsConfigPath(file: string): boolean {
  return CONFIG_NAME.test(path.posix.basename(file));
}

// A relative or extension-less Node-style specifier already joined to its directory: the file
// itself, the usual extensions, an index file, or a `.js` suffix that names a TypeScript source.
export function probeNodeFile(base: string, knownFiles: ReadonlySet<string>): string | undefined {
  const candidates = [base];
  for (const ext of TS_EXTENSIONS) candidates.push(base + ext);
  for (const ext of TS_EXTENSIONS) candidates.push(`${base}/index${ext}`);
  if (base.endsWith(".js") || base.endsWith(".mjs") || base.endsWith(".cjs")) {
    const swapped = base.replace(/\.(m|c)?js$/, ".ts");
    candidates.push(swapped, swapped.replace(/\.ts$/, ".mts"), base.replace(/\.js$/, ".tsx"));
  }
  return candidates.find((candidate) => knownFiles.has(candidate));
}

// tsconfig.json allows comments and trailing commas; strip both outside strings before parsing.
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') { if (text[j] === "\\") j++; j++; }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === "}" || text[j] === "]") i++;
      else { out += ch; i++; }
    } else { out += ch; i++; }
  }
  try { return JSON.parse(out); } catch { return undefined; }
}

interface RawConfig {
  readonly dir: string;
  readonly extends: readonly string[];
  readonly baseUrl: string | undefined;
  readonly paths: ReadonlyMap<string, readonly string[]> | undefined;
}

export interface EffectiveTsConfig {
  /** Directory the `paths` targets are relative to: `baseUrl` when one is set, else the declaring config's directory. */
  readonly pathsRoot: string;
  readonly paths: ReadonlyMap<string, readonly string[]>;
  readonly baseUrl: string | undefined;
}

export type AliasOutcome = { readonly kind: "file"; readonly file: string } | { readonly kind: "ambiguous" } | { readonly kind: "none" };

const dirOf = (file: string): string => { const dir = path.posix.dirname(file); return dir === "." ? "" : dir; };
const joinDir = (dir: string, rel: string): string => { const joined = path.posix.normalize(path.posix.join(dir, rel)); return joined === "." ? "" : joined; };

function rawConfig(file: string, card: FileCard): RawConfig | undefined {
  const json = parseJsonc(card.text);
  if (typeof json !== "object" || json === null) return undefined;
  const record = json as Record<string, unknown>;
  const options = typeof record.compilerOptions === "object" && record.compilerOptions !== null ? record.compilerOptions as Record<string, unknown> : {};
  const extendsField = typeof record.extends === "string" ? [record.extends] : Array.isArray(record.extends) ? record.extends.filter((item): item is string => typeof item === "string") : [];
  let paths: Map<string, readonly string[]> | undefined;
  if (typeof options.paths === "object" && options.paths !== null && !Array.isArray(options.paths)) {
    paths = new Map();
    for (const [key, value] of Object.entries(options.paths as Record<string, unknown>)) {
      const targets = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? [value] : [];
      paths.set(key, targets);
    }
  }
  return { dir: dirOf(file), extends: extendsField, baseUrl: typeof options.baseUrl === "string" ? options.baseUrl : undefined, paths };
}

export class TsConfigs {
  private readonly raw = new Map<string, RawConfig | null>();
  private readonly effective = new Map<string, EffectiveTsConfig | null>();
  private readonly nearestByDir = new Map<string, string | null>();

  constructor(private readonly files: ReadonlyMap<string, FileCard>) {}

  private rawOf(file: string): RawConfig | undefined {
    const cached = this.raw.get(file);
    if (cached !== undefined) return cached ?? undefined;
    const card = this.files.get(file);
    const parsed = card === undefined || !isTsConfigPath(file) ? undefined : rawConfig(file, card);
    this.raw.set(file, parsed ?? null);
    return parsed;
  }

  // Later `extends` entries override earlier ones, and the extending config overrides them all.
  // A package name in `extends` is unknown: no node_modules is read, so the chain stops there
  // with whatever the nearer configs declared.
  private effectiveOf(file: string): EffectiveTsConfig | undefined {
    const cached = this.effective.get(file);
    if (cached !== undefined) return cached ?? undefined;
    this.effective.set(file, null);
    const result = this.walk(file, new Set());
    this.effective.set(file, result ?? null);
    return result;
  }

  private walk(file: string, visited: Set<string>): EffectiveTsConfig | undefined {
    if (visited.has(file)) return undefined;
    visited.add(file);
    const raw = this.rawOf(file);
    if (raw === undefined) return undefined;
    let paths: { root: string; entries: ReadonlyMap<string, readonly string[]> } | undefined;
    let baseUrl: string | undefined;
    for (const parent of raw.extends) {
      if (!parent.startsWith("./") && !parent.startsWith("../")) continue;
      const target = joinDir(raw.dir, parent.endsWith(".json") ? parent : `${parent}.json`);
      if (!isTsConfigPath(target)) continue;
      const inherited = this.walk(target, visited);
      if (inherited === undefined) continue;
      if (inherited.baseUrl !== undefined) baseUrl = inherited.baseUrl;
      if (inherited.paths.size > 0) paths = { root: inherited.pathsRoot, entries: inherited.paths };
    }
    if (raw.baseUrl !== undefined) baseUrl = joinDir(raw.dir, raw.baseUrl);
    if (raw.paths !== undefined) paths = { root: raw.dir, entries: raw.paths };
    const pathsRoot = baseUrl ?? paths?.root ?? raw.dir;
    return { pathsRoot, paths: paths?.entries ?? new Map(), baseUrl };
  }

  private nearest(fromFile: string): string | undefined {
    const dir = dirOf(fromFile);
    const cached = this.nearestByDir.get(dir);
    if (cached !== undefined) return cached ?? undefined;
    let current = dir;
    let found: string | undefined;
    for (;;) {
      for (const name of ["tsconfig.json", "jsconfig.json"]) {
        const candidate = current === "" ? name : `${current}/${name}`;
        if (this.files.has(candidate)) { found = candidate; break; }
      }
      if (found !== undefined || current === "") break;
      current = dirOf(current);
    }
    this.nearestByDir.set(dir, found ?? null);
    return found;
  }

  resolve(fromFile: string, spec: string, knownFiles: ReadonlySet<string>): AliasOutcome {
    const config = this.nearest(fromFile);
    const effective = config === undefined ? undefined : this.effectiveOf(config);
    if (effective === undefined) return { kind: "none" };
    const matched = matchPaths(effective.paths, spec);
    if (matched === "ambiguous") return { kind: "ambiguous" };
    if (matched !== undefined) {
      for (const target of matched) {
        const joined = path.posix.normalize(path.posix.join(effective.pathsRoot, target));
        if (joined.startsWith("..")) continue;
        const found = probeNodeFile(joined, knownFiles);
        if (found !== undefined) return { kind: "file", file: found };
      }
    }
    if (effective.baseUrl !== undefined) {
      const joined = path.posix.normalize(path.posix.join(effective.baseUrl, spec));
      if (!joined.startsWith("..")) {
        const found = probeNodeFile(joined, knownFiles);
        if (found !== undefined) return { kind: "file", file: found };
      }
    }
    return { kind: "none" };
  }
}

// An exact key wins outright. Among `*` patterns the longest literal prefix wins, as the compiler
// resolves it; two patterns with the same prefix length are ambiguous rather than order-dependent.
export function matchPaths(paths: ReadonlyMap<string, readonly string[]>, spec: string): readonly string[] | "ambiguous" | undefined {
  const exact = paths.get(spec);
  if (exact !== undefined) return exact;
  const index = wildcardIndexOf(paths);
  for (const prefixLength of index.prefixLengths) {
    if (prefixLength > spec.length) continue;
    const group = index.byPrefix.get(spec.slice(0, prefixLength));
    if (group === undefined) continue;
    let found: { targets: readonly string[]; suffixLength: number } | undefined;
    for (const suffixLength of group.suffixLengths) {
      if (prefixLength + suffixLength > spec.length) continue;
      const targets = group.bySuffix.get(spec.slice(spec.length - suffixLength));
      if (targets === undefined) continue;
      if (found !== undefined) return "ambiguous";
      found = { targets, suffixLength };
    }
    if (found === undefined) continue;
    const filler = spec.slice(prefixLength, spec.length - found.suffixLength);
    return found.targets.map((target) => target.split("*").join(filler));
  }
  return undefined;
}

interface WildcardGroup {
  readonly bySuffix: Map<string, readonly string[]>;
  readonly suffixLengths: number[];
}

interface WildcardIndex {
  readonly byPrefix: ReadonlyMap<string, WildcardGroup>;
  readonly prefixLengths: readonly number[];
}

const wildcardIndexes = new WeakMap<ReadonlyMap<string, readonly string[]>, WildcardIndex>();

function wildcardIndexOf(paths: ReadonlyMap<string, readonly string[]>): WildcardIndex {
  const cached = wildcardIndexes.get(paths);
  if (cached !== undefined) return cached;
  const byPrefix = new Map<string, WildcardGroup>();
  for (const [key, targets] of paths) {
    const star = key.indexOf("*");
    if (star < 0 || key.indexOf("*", star + 1) >= 0) continue;
    const prefix = key.slice(0, star), suffix = key.slice(star + 1);
    let group = byPrefix.get(prefix);
    if (group === undefined) { group = { bySuffix: new Map(), suffixLengths: [] }; byPrefix.set(prefix, group); }
    if (!group.suffixLengths.includes(suffix.length)) group.suffixLengths.push(suffix.length);
    group.bySuffix.set(suffix, targets);
  }
  const prefixLengths = [...new Set([...byPrefix.keys()].map((prefix) => prefix.length))].sort((a, b) => b - a);
  const index = { byPrefix, prefixLengths };
  wildcardIndexes.set(paths, index);
  return index;
}
