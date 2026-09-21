import path from "node:path";
import type { CardLanguage, FileCard } from "../types.js";

export type LockMap = ReadonlyMap<string, string>;

export interface PnpmLock {
  /** Importer directory (relative to the lockfile, "." for the root) to its declared dependency versions. */
  readonly importers: ReadonlyMap<string, LockMap>;
  /** Every locked package that has exactly one version. */
  readonly packages: LockMap;
}

export interface Lockfiles {
  readonly npm?: PnpmLock | undefined;
  readonly python?: LockMap | undefined;
  readonly go?: LockMap | undefined;
  readonly cargo?: LockMap | undefined;
}

const NPM_LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"];
const PYTHON_LOCKFILES = ["uv.lock", "poetry.lock", "Pipfile.lock"];
const GO_LOCKFILES = ["go.mod", "go.sum"];
const CARGO_LOCKFILES = ["Cargo.lock"];

const unique = (pairs: Iterable<readonly [string, string]>): LockMap => {
  const versions = new Map<string, Set<string>>();
  for (const [name, version] of pairs) {
    const set = versions.get(name);
    if (set === undefined) versions.set(name, new Set([version]));
    else set.add(version);
  }
  return new Map([...versions].filter(([, set]) => set.size === 1).map(([name, set]) => [name, [...set][0]!]));
};

const stripPeers = (version: string): string => version.replace(/\(.*$/, "").trim();
// `zod@3.24.3` is an aliased dependency: the version is what follows the last package-name `@`.
const versionOf = (value: string): string | undefined => {
  const plain = stripPeers(value);
  if (plain.length === 0 || plain.startsWith("link:") || plain.startsWith("file:") || plain.startsWith("workspace:")) return undefined;
  const at = plain.lastIndexOf("@");
  return at > 0 ? plain.slice(at + 1) : plain;
};
const splitAt = (key: string): readonly [string, string] | undefined => {
  const at = key.lastIndexOf("@");
  if (at <= 0) return undefined;
  const version = key.slice(at + 1);
  return /^\d/.test(version) ? [key.slice(0, at), version] : undefined;
};
const unquote = (value: string): string => value.replace(/^['"]|['"]$/g, "");

export function parsePnpmLock(text: string): PnpmLock {
  const importers = new Map<string, Map<string, string>>();
  const packages: Array<readonly [string, string]> = [];
  let section: "importers" | "packages" | "other" = "other";
  let importer: Map<string, string> | undefined;
  let dependency: string | undefined;
  for (const line of text.split("\n")) {
    if (line.length === 0 || line.startsWith("#")) continue;
    if (!line.startsWith(" ")) { section = line === "importers:" ? "importers" : line === "packages:" ? "packages" : "other"; importer = undefined; dependency = undefined; continue; }
    if (section === "packages") {
      const match = /^ {2}'?([^'\s:]+)'?:/.exec(line);
      if (match?.[1] === undefined) continue;
      const key = match[1].startsWith("/") ? match[1].slice(1) : match[1];
      const pair = splitAt(key) ?? (/^(@?[^@/]+(?:\/[^@/]+)?)\/(\d.*)$/.exec(key)?.slice(1, 3) as [string, string] | undefined);
      if (pair !== undefined) packages.push([pair[0], stripPeers(pair[1])]);
      continue;
    }
    if (section !== "importers") continue;
    const level = /^ */.exec(line)![0].length;
    if (level === 2) { const name = unquote(line.trim().replace(/:.*$/, "")); importer = new Map(); importers.set(name, importer); dependency = undefined; continue; }
    if (level === 6) { dependency = unquote(line.trim().replace(/:$/, "")); continue; }
    if (level === 8 && dependency !== undefined && importer !== undefined) {
      const match = /^\s*version:\s*(.+)$/.exec(line);
      const version = match?.[1] === undefined ? undefined : versionOf(unquote(match[1].trim()));
      if (version !== undefined) importer.set(dependency, version);
    }
  }
  return { importers, packages: unique(packages) };
}

export function parsePackageLock(text: string): LockMap {
  let json: unknown;
  try { json = JSON.parse(text); } catch { return new Map(); }
  if (typeof json !== "object" || json === null) return new Map();
  const record = json as { packages?: Record<string, { version?: unknown }>; dependencies?: Record<string, { version?: unknown }> };
  const pairs: Array<readonly [string, string]> = [];
  if (typeof record.packages === "object" && record.packages !== null) {
    for (const [key, entry] of Object.entries(record.packages)) {
      const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key);
      if (match?.[1] !== undefined && typeof entry?.version === "string") pairs.push([match[1], entry.version]);
    }
  } else if (typeof record.dependencies === "object" && record.dependencies !== null) {
    for (const [name, entry] of Object.entries(record.dependencies)) if (typeof entry?.version === "string") pairs.push([name, entry.version]);
  }
  return unique(pairs);
}

export function parseYarnLock(text: string): LockMap {
  const pairs: Array<readonly [string, string]> = [];
  let names: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0 || line.startsWith("#")) continue;
    if (!line.startsWith(" ")) {
      names = line.replace(/:\s*$/, "").split(",").map((part) => unquote(part.trim())).flatMap((key) => {
        const at = key.indexOf("@", 1);
        return at > 0 ? [key.slice(0, at)] : [];
      });
      continue;
    }
    const match = /^\s+version:?\s+"?([^"\s]+)"?/.exec(line);
    if (match?.[1] !== undefined) for (const name of names) pairs.push([name, match[1]]);
  }
  return unique(pairs);
}

export const normalizePythonName = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, "-");

function parseTomlPackages(text: string): LockMap {
  const pairs: Array<readonly [string, string]> = [];
  let name: string | undefined;
  let inPackage = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) { inPackage = trimmed === "[[package]]"; name = undefined; continue; }
    if (!inPackage) continue;
    const nameMatch = /^name\s*=\s*"([^"]+)"/.exec(trimmed);
    if (nameMatch?.[1] !== undefined) { name = nameMatch[1]; continue; }
    const versionMatch = /^version\s*=\s*"([^"]+)"/.exec(trimmed);
    if (versionMatch?.[1] !== undefined && name !== undefined) pairs.push([name, versionMatch[1]]);
  }
  return unique(pairs);
}

const pythonNormalized = (map: LockMap): LockMap => unique([...map].map(([name, version]) => [normalizePythonName(name), version] as const));

export function parsePoetryLock(text: string): LockMap { return pythonNormalized(parseTomlPackages(text)); }
export function parseUvLock(text: string): LockMap { return pythonNormalized(parseTomlPackages(text)); }
export function parseCargoLock(text: string): LockMap { return parseTomlPackages(text); }

export function parsePipfileLock(text: string): LockMap {
  let json: unknown;
  try { json = JSON.parse(text); } catch { return new Map(); }
  if (typeof json !== "object" || json === null) return new Map();
  const pairs: Array<readonly [string, string]> = [];
  for (const section of ["default", "develop"]) {
    const entries = (json as Record<string, unknown>)[section];
    if (typeof entries !== "object" || entries === null) continue;
    for (const [name, entry] of Object.entries(entries as Record<string, { version?: unknown }>)) {
      if (typeof entry?.version === "string" && entry.version.startsWith("==")) pairs.push([normalizePythonName(name), entry.version.slice(2)]);
    }
  }
  return unique(pairs);
}

export function parseRequirements(text: string): LockMap {
  const pairs: Array<readonly [string, string]> = [];
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*==\s*([^\s;\\#]+)/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) pairs.push([normalizePythonName(match[1]), match[2]]);
  }
  return unique(pairs);
}

export function parseGoMod(text: string): LockMap {
  const pairs: Array<readonly [string, string]> = [];
  let block = false;
  for (const line of text.split("\n")) {
    const trimmed = line.replace(/\/\/.*$/, "").trim();
    if (block) {
      if (trimmed === ")") { block = false; continue; }
      const match = /^(\S+)\s+(v\S+)$/.exec(trimmed);
      if (match?.[1] !== undefined && match[2] !== undefined) pairs.push([match[1], match[2]]);
      continue;
    }
    if (trimmed === "require (") { block = true; continue; }
    const single = /^require\s+(\S+)\s+(v\S+)$/.exec(trimmed);
    if (single?.[1] !== undefined && single[2] !== undefined) pairs.push([single[1], single[2]]);
  }
  return unique(pairs);
}

export function parseGoSum(text: string): LockMap {
  const pairs: Array<readonly [string, string]> = [];
  for (const line of text.split("\n")) {
    const match = /^(\S+)\s+(v\S+?)(\/go\.mod)?\s+h1:/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined && match[3] === undefined) pairs.push([match[1], match[2]]);
  }
  return unique(pairs);
}

/** Lockfiles by directory, nearest-above lookup; the first present lockfile of each ecosystem wins. */
export function collectLockfiles(files: ReadonlyMap<string, FileCard>): ReadonlyMap<string, Lockfiles> {
  const byDir = new Map<string, Map<string, FileCard>>();
  for (const [file, card] of files) {
    const base = path.posix.basename(file);
    if (!NPM_LOCKFILES.includes(base) && !PYTHON_LOCKFILES.includes(base) && !GO_LOCKFILES.includes(base) && !CARGO_LOCKFILES.includes(base) && !/^requirements[^/]*\.txt$/.test(base)) continue;
    const dir = path.posix.dirname(file) === "." ? "" : path.posix.dirname(file);
    let group = byDir.get(dir);
    if (group === undefined) { group = new Map(); byDir.set(dir, group); }
    group.set(base, card);
  }
  const out = new Map<string, Lockfiles>();
  for (const [dir, group] of [...byDir].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const text = (name: string): string | undefined => group.get(name)?.text;
    const npm = text("pnpm-lock.yaml") !== undefined ? parsePnpmLock(text("pnpm-lock.yaml")!)
      : text("package-lock.json") !== undefined ? { importers: new Map([[".", parsePackageLock(text("package-lock.json")!)]]), packages: new Map() }
      : text("yarn.lock") !== undefined ? { importers: new Map([[".", parseYarnLock(text("yarn.lock")!)]]), packages: new Map() } : undefined;
    const requirements = [...group.keys()].filter((name) => /^requirements[^/]*\.txt$/.test(name)).sort();
    const python = text("uv.lock") !== undefined ? parseUvLock(text("uv.lock")!)
      : text("poetry.lock") !== undefined ? parsePoetryLock(text("poetry.lock")!)
      : text("Pipfile.lock") !== undefined ? parsePipfileLock(text("Pipfile.lock")!)
      : requirements.length > 0 ? unique(requirements.flatMap((name) => [...parseRequirements(text(name)!)])) : undefined;
    const go = text("go.mod") !== undefined && parseGoMod(text("go.mod")!).size > 0 ? parseGoMod(text("go.mod")!)
      : text("go.sum") !== undefined ? parseGoSum(text("go.sum")!) : undefined;
    const cargo = text("Cargo.lock") !== undefined ? parseCargoLock(text("Cargo.lock")!) : undefined;
    if (npm === undefined && python === undefined && go === undefined && cargo === undefined) continue;
    out.set(dir, { npm, python, go, cargo });
  }
  return out;
}

function nearest(lockfiles: ReadonlyMap<string, Lockfiles>, fromFile: string): Array<readonly [string, Lockfiles]> {
  const fromDir = path.posix.dirname(fromFile) === "." ? "" : path.posix.dirname(fromFile);
  return [...lockfiles].filter(([dir]) => dir === "" || fromDir === dir || fromDir.startsWith(`${dir}/`)).sort(([a], [b]) => b.length - a.length);
}

export interface ExternalInput {
  readonly lockfiles: ReadonlyMap<string, Lockfiles>;
  readonly workspacePackages: ReadonlySet<string>;
  readonly pythonRoots: readonly { readonly dir: string }[];
  readonly goModules: ReadonlySet<string>;
  readonly cargoPackages: ReadonlySet<string>;
  readonly cargoDependencies: ReadonlyMap<string, ReadonlySet<string>>;
  readonly knownFiles: ReadonlySet<string>;
}

const NPM_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;
const RUST_STD = new Set(["std", "core", "alloc", "proc_macro", "test"]);
const label = (name: string, version: string | undefined): string => version === undefined ? name : `${name}@${version}`;

/**
 * The package an unresolved import specifier names when it lies outside the workspace, with the
 * version a lockfile above the importing file pins. Relative paths, aliases, workspace packages,
 * workspace Go modules and workspace crates are in-repo and stay unlabelled.
 */
export function externalLabel(language: CardLanguage, fromFile: string, spec: string, input: ExternalInput): string | undefined {
  if (language === "typescript" || language === "tsx" || language === "javascript") {
    if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("#") || spec.startsWith("~")) return undefined;
    if (spec.startsWith("node:")) return spec;
    const segments = spec.split("/");
    const name = spec.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]!;
    if (!NPM_NAME.test(name) || input.workspacePackages.has(name)) return undefined;
    for (const [dir, lock] of nearest(input.lockfiles, fromFile)) {
      if (lock.npm === undefined) continue;
      const fromDir = path.posix.dirname(fromFile) === "." ? "" : path.posix.dirname(fromFile);
      const relative = dir === "" ? fromDir : fromDir === dir ? "" : fromDir.slice(dir.length + 1);
      const importers = [...lock.npm.importers.keys()].filter((importer) => importer === "." || relative === importer || relative.startsWith(`${importer}/`)).sort((a, b) => b.length - a.length);
      for (const importer of importers) { const version = lock.npm.importers.get(importer)?.get(name); if (version !== undefined) return label(name, version); }
      return label(name, lock.npm.packages.get(name));
    }
    return name;
  }
  if (language === "python") {
    if (spec.startsWith(".")) return undefined;
    const name = spec.split(".")[0]!;
    if (name.length === 0) return undefined;
    for (const root of input.pythonRoots) {
      const modulePath = root.dir === "" ? name : `${root.dir}/${name}`;
      if (input.knownFiles.has(`${modulePath}/__init__.py`) || input.knownFiles.has(`${modulePath}.py`)) return undefined;
    }
    for (const [, lock] of nearest(input.lockfiles, fromFile)) {
      if (lock.python === undefined) continue;
      return label(name, lock.python.get(normalizePythonName(name)));
    }
    return name;
  }
  if (language === "go") {
    for (const module of input.goModules) if (spec === module || spec.startsWith(`${module}/`)) return undefined;
    for (const [, lock] of nearest(input.lockfiles, fromFile)) {
      if (lock.go === undefined) continue;
      let module: string | undefined;
      for (const candidate of lock.go.keys()) if ((spec === candidate || spec.startsWith(`${candidate}/`)) && (module === undefined || candidate.length > module.length)) module = candidate;
      return module === undefined ? spec : label(module, lock.go.get(module));
    }
    return spec;
  }
  if (language === "rust") {
    // A Rust head names a crate only when the standard library, a Cargo.toml dependency table or
    // Cargo.lock knows it; any other head is a module of this crate the index could not follow.
    const head = spec.split("::").filter((part) => part.length > 0)[0];
    if (head === undefined || head === "crate" || head === "self" || head === "super" || input.cargoPackages.has(head)) return undefined;
    const fromDir = path.posix.dirname(fromFile) === "." ? "" : path.posix.dirname(fromFile);
    const declared = [...input.cargoDependencies].some(([dir, names]) => (dir === "" || fromDir === dir || fromDir.startsWith(`${dir}/`)) && names.has(head));
    const lock = nearest(input.lockfiles, fromFile).find(([, item]) => item.cargo !== undefined)?.[1].cargo;
    const found = lock === undefined ? undefined : [...lock].find(([name]) => name.replace(/-/g, "_") === head);
    if (!RUST_STD.has(head) && !declared && found === undefined) return undefined;
    return label(head, found?.[1]);
  }
  return undefined;
}
