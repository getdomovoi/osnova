import { createHash } from "node:crypto";

interface CaseBase {
  readonly id: string;
  readonly split: "development" | "evaluation";
  readonly expected: readonly string[];
  readonly anchors: readonly { file: string; text: string }[];
}

export type BenchmarkCase = CaseBase & (
  | { readonly kind: "ask"; readonly question: string; readonly in?: string }
  | { readonly kind: "callers"; readonly symbol: string; readonly direction?: "in" | "out"; readonly depth?: number }
  | { readonly kind: "findText"; readonly pattern: string; readonly fixed?: boolean; readonly in?: string }
);

export interface BenchmarkManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly source:
    | { readonly kind: "inline"; readonly files: Readonly<Record<string, string>> }
    | { readonly kind: "checkout"; readonly revision: string };
  readonly edit: { readonly file: string; readonly append: string };
  readonly cases: readonly BenchmarkCase[];
}

function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`invalid benchmark manifest: ${message}`);
}

function object(value: unknown): Record<string, unknown> {
  ensure(typeof value === "object" && value !== null && !Array.isArray(value), "expected object");
  return value as Record<string, unknown>;
}

export function validateRelativePath(value: unknown): asserts value is string {
  ensure(typeof value === "string" && value.length > 0 &&
    !/[\\:]/.test(value) && [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git"),
  "expected a safe relative path");
}

export function parseManifest(value: unknown): BenchmarkManifest {
  const manifest = object(value);
  ensure(manifest.schemaVersion === 1, "unsupported schemaVersion");
  ensure(typeof manifest.id === "string" && /^[a-z0-9-]+$/.test(manifest.id), "invalid corpus id");
  const source = object(manifest.source);
  if (source.kind === "inline") {
    const files = object(source.files);
    ensure(Object.keys(files).length > 0, "source files must not be empty");
    for (const [file, content] of Object.entries(files)) {
      validateRelativePath(file);
      ensure(typeof content === "string", "inline file content must be a string");
    }
  } else {
    ensure(source.kind === "checkout", "unknown source kind");
    ensure(typeof source.revision === "string" && /^[a-f0-9]{40}$/.test(source.revision), "revision must be a full immutable commit hash");
  }
  const edit = object(manifest.edit);
  validateRelativePath(edit.file);
  ensure(typeof edit.append === "string" && edit.append.length > 0, "edit append must not be empty");
  ensure(Array.isArray(manifest.cases) && manifest.cases.length > 0, "cases must not be empty");
  const ids = new Set<string>();
  for (const entry of manifest.cases) {
    const item = object(entry);
    ensure(typeof item.id === "string" && /^[a-z0-9-]+$/.test(item.id), "invalid case id");
    ensure(!ids.has(item.id), "duplicate case id");
    ids.add(item.id);
    ensure(item.split === "development" || item.split === "evaluation", "invalid case split");
    ensure(Array.isArray(item.expected) && item.expected.every((id: unknown) => typeof id === "string" && id.length > 0), "invalid expected IDs");
    ensure(new Set(item.expected).size === item.expected.length, "duplicate expected IDs");
    ensure(Array.isArray(item.anchors) && item.anchors.length > 0, "source anchors required");
    for (const value of item.anchors) {
      const anchor = object(value);
      validateRelativePath(anchor.file);
      ensure(typeof anchor.text === "string" && anchor.text.length > 0, "anchor text required");
    }
    if (item.in !== undefined) validateRelativePath(item.in);
    if (item.kind === "ask") {
      ensure(typeof item.question === "string" && item.question.length > 0, "question required");
      ensure(item.expected.length > 0, "nonempty relevance labels required");
    } else if (item.kind === "callers") {
      ensure(typeof item.symbol === "string" && item.symbol.length > 0, "symbol required");
      ensure(item.direction === undefined || item.direction === "in" || item.direction === "out", "invalid direction");
      ensure(item.depth === undefined || (typeof item.depth === "number" && Number.isSafeInteger(item.depth) && item.depth > 0), "invalid depth");
    } else {
      ensure(item.kind === "findText", "unknown case kind");
      ensure(typeof item.pattern === "string" && item.pattern.length > 0, "pattern required");
      ensure(item.fixed === undefined || typeof item.fixed === "boolean", "invalid fixed option");
    }
  }
  return manifest as unknown as BenchmarkManifest;
}

export function manifestFingerprint(manifest: BenchmarkManifest): string {
  const serialized = JSON.stringify(manifest, (_key: string, value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
  return createHash("sha256").update(serialized).digest("hex");
}
