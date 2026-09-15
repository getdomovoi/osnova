import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { resolveCacheDir } from "../cache/cache.js";
import { getParser } from "../grammar/loader.js";
import { extensionLanguage, grammarFile, languageTier } from "../grammar/languages.js";
import type { LanguageId } from "../types.js";

export interface DiagnosticCheck {
  readonly id: string;
  readonly status: "ok" | "warning" | "error";
  readonly message: string;
}

export interface LanguageCapability {
  readonly language: LanguageId;
  readonly extensions: readonly string[];
  readonly status: "ok" | "error";
  readonly extraction: "syntax" | "tags";
  readonly resolution: "binding-and-receiver-hints" | "name-heuristics";
  readonly typeInference: false;
  readonly limitations: readonly string[];
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly readOnly: true;
  readonly checks: readonly DiagnosticCheck[];
  readonly capabilities: readonly LanguageCapability[];
  readonly fallback: string;
}

export interface DoctorOptions {
  readonly cacheDir?: string | undefined;
}

export async function doctor(workspace: string, options: DoctorOptions = {}): Promise<DoctorReport> {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const runtimeOk = major > 22 || (major === 22 && minor >= 13);
  const checks: DiagnosticCheck[] = [{
    id: "runtime", status: runtimeOk ? "ok" : "error",
    message: `Node ${process.versions.node}; requires >=22.13.0. Platform ${process.platform}/${process.arch}.`,
  }];
  try {
    if (!(await stat(path.resolve(workspace))).isDirectory()) throw new Error("not-directory");
    await access(path.resolve(workspace), constants.R_OK | constants.X_OK);
    checks.push({ id: "workspace", status: "ok", message: "Workspace directory is readable and searchable; source files were not scanned." });
  } catch {
    checks.push({ id: "workspace", status: "error", message: "Workspace is missing, not a directory, or inaccessible." });
  }
  const cache = path.resolve(resolveCacheDir(options.cacheDir));
  let candidate = cache;
  try {
    while (true) {
      try {
        if (!(await stat(candidate)).isDirectory()) throw new Error("not-directory");
        await access(candidate, constants.R_OK | constants.W_OK | constants.X_OK);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = path.dirname(candidate);
        if (parent === candidate) throw error;
        candidate = parent;
      }
    }
    checks.push({
      id: "cache", status: candidate === cache ? "ok" : "warning",
      message: candidate === cache
        ? "Cache directory access checks succeeded. No write probe performed; capacity, atomic publication and artifact validity are unverified."
        : "Cache is absent; nearest existing ancestor permits access. No directory created; actual write capability and capacity are unverified.",
    });
  } catch {
    checks.push({ id: "cache", status: "error", message: "Cache path or its existing ancestor is not an accessible writable directory. No writes attempted." });
  }
  const samples: Record<LanguageId, string> = {
    typescript: "function probe(): number { return 1; }",
    tsx: "const probe = <div />;",
    javascript: "function probe() { return 1; }",
    python: "def probe():\n    return 1\n",
    go: "package probe\nfunc Probe() {}\n",
    rust: "fn probe() {}",
    java: "class Probe { void probe() {} }",
    c_sharp: "class Probe { void Run() {} }",
    c: "int probe() { return 1; }",
    cpp: "int probe() { return 1; }",
    ruby: "def probe\n  1\nend\n",
    php: "<?php\nfunction probe() { return 1; }\n",
    kotlin: "fun probe(): Int { return 1 }",
    swift: "func probe() -> Int { return 1 }",
    scala: "object Probe { def probe(): Int = 1 }",
    dart: "int probe() { return 1; }",
    elixir: "defmodule Probe do\n  def probe do\n    1\n  end\nend\n",
    ocaml: "let probe () = 1",
    zig: "fn probe() i32 { return 1; }",
    bash: "probe() { echo 1; }",
  };
  const genericLimitations: readonly string[] = [
    "Definitions and bare call names come from a tags query; imports, exports, bindings and receivers are not analyzed.",
    "Name-based resolution can be ambiguous or incomplete.",
    "No binding-aware receiver identity or runtime dispatch proof.",
  ];
  const extraLimitations: Partial<Record<LanguageId, readonly string[]>> = {
    dart: ["Call edges are not extracted for Dart; the tags query only records definitions."],
  };
  const capabilities: LanguageCapability[] = [];
  for (const language of Object.keys(grammarFile).sort() as LanguageId[]) {
    let status: "ok" | "error" = "ok";
    try {
      const parser = await getParser(language);
      const tree = parser.parse(samples[language]);
      try {
        if (!tree || tree.rootNode.hasError) status = "error";
      } finally {
        tree?.delete();
      }
    } catch {
      status = "error";
    }
    const generic = languageTier[language] === "generic";
    const bindingHints = ["typescript", "tsx", "javascript", "python"].includes(language);
    capabilities.push({
      language, status,
      extensions: Object.entries(extensionLanguage).filter(([, value]) => value === language).map(([ext]) => ext).sort(),
      extraction: generic ? "tags" : "syntax",
      resolution: bindingHints ? "binding-and-receiver-hints" : "name-heuristics",
      typeInference: false,
      limitations: generic
        ? [...genericLimitations, ...(extraLimitations[language] ?? [])]
        : bindingHints
          ? ["Hints are not runtime type proofs.", "Dynamic dispatch, arbitrary value flow and inheritance are not resolved.", "Ambiguous or unsupported bindings remain unresolved."]
          : ["Name-based resolution can be ambiguous or incomplete.", "No binding-aware receiver identity or runtime dispatch proof."],
    });
    checks.push({ id: `grammar:${language}`, status, message: status === "ok" ? "Packaged WASM loaded and parsed a synthetic snippet without syntax errors." : "WASM load or synthetic parse failed; check installed parser and grammar assets. No download attempted." });
  }
  return {
    ok: checks.every((check) => check.status !== "error"), readOnly: true, checks, capabilities,
    fallback: "Other eligible text files receive file cards without structural extraction. Declaration files may be excluded; scan eligibility is separate from grammar availability.",
  };
}
