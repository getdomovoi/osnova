import { describe, expect, it } from "vitest";
import { getParser, loadLanguage, probeGrammars } from "../src/grammar/loader.js";
import { languageForPath, genericLanguages, languageTier, grammarFile } from "../src/grammar/languages.js";
import { queryFor, queriesFingerprint } from "../src/grammar/queries/index.js";

describe("grammar loader", () => {
  it("probes the typescript grammar without ABI errors", async () => {
    await expect(probeGrammars()).resolves.toBeUndefined();
  });

  it("loads and caches every v1 grammar", async () => {
    for (const language of [
      "typescript",
      "tsx",
      "javascript",
      "python",
      "go",
      "rust",
      "java",
      "c_sharp",
    ] as const) {
      const language1 = await loadLanguage(language);
      const language2 = await loadLanguage(language);
      expect(language1.abiVersion).toBeGreaterThanOrEqual(13);
      expect(language2).toBe(language1);
    }
  });

  it("parses a snippet per language", async () => {
    const samples: Record<string, string> = {
      typescript: "export function foo(): number { return 1; }",
      tsx: 'const el = <div className="a">hi</div>;',
      javascript: "function foo() { return 1 }",
      python: "def foo():\n    return 1\n",
      go: "func main() {}",
      rust: "fn main() {}",
      java: "class A { void m() {} }",
      c_sharp: "class A { void M() {} }",
      c: "#include <stdio.h>",
      cpp: "namespace geo {",
      ruby: "module Greeting",
      php: "<?php",
      kotlin: "package app",
      swift: "struct Point { var x: Int; var y: Int }",
      scala: "package app",
      dart: "class Greeter {",
      elixir: "defmodule Greeter do",
      ocaml: "module Greeter = struct",
      zig: "const Greeter = struct {",
      bash: "#!/usr/bin/env bash",
    };
    for (const [language, source] of Object.entries(samples)) {
      const parser = await getParser(language as never);
      const tree = parser.parse(source);
      expect(tree, language).not.toBeNull();
      tree?.delete();
    }
  });

  it("maps extensions to languages and skips declarations", () => {
    expect(languageForPath("src/a.ts")).toBe("typescript");
    expect(languageForPath("src/a.tsx")).toBe("tsx");
    expect(languageForPath("src/a.d.ts")).toBeUndefined();
    expect(languageForPath("src/a.mjs")).toBe("javascript");
    expect(languageForPath("src/a.py")).toBe("python");
    expect(languageForPath("src/a.go")).toBe("go");
    expect(languageForPath("src/a.rs")).toBe("rust");
    expect(languageForPath("src/a.java")).toBe("java");
    expect(languageForPath("src/a.cs")).toBe("c_sharp");
    expect(languageForPath("src/a.txt")).toBeUndefined();
  });
});

describe("breadth registry", () => {
  it("lists twelve generic languages with grammars and queries", () => {
    expect([...genericLanguages].sort()).toEqual(["bash", "c", "cpp", "dart", "elixir", "kotlin", "ocaml", "php", "ruby", "scala", "swift", "zig"]);
    for (const language of genericLanguages) {
      expect(languageTier[language]).toBe("generic");
      expect(grammarFile[language]).toMatch(/^tree-sitter-[a-z_]+\.wasm$/);
      expect(queryFor(language)).toMatch(/@definition\./);
    }
    expect(queriesFingerprint).toMatch(/^[a-f0-9]{16}$/);
  });

  it("maps breadth extensions", () => {
    expect(languageForPath("a.c")).toBe("c");
    expect(languageForPath("a.h")).toBe("c");
    expect(languageForPath("a.cpp")).toBe("cpp");
    expect(languageForPath("a.hpp")).toBe("cpp");
    expect(languageForPath("a.rb")).toBe("ruby");
    expect(languageForPath("a.php")).toBe("php");
    expect(languageForPath("a.kt")).toBe("kotlin");
    expect(languageForPath("a.swift")).toBe("swift");
    expect(languageForPath("a.scala")).toBe("scala");
    expect(languageForPath("a.dart")).toBe("dart");
    expect(languageForPath("a.ex")).toBe("elixir");
    expect(languageForPath("a.ml")).toBe("ocaml");
    expect(languageForPath("a.zig")).toBe("zig");
    expect(languageForPath("a.sh")).toBe("bash");
  });

  it("loads every breadth grammar", async () => {
    for (const language of genericLanguages) {
      const loaded = await loadLanguage(language);
      expect(loaded.abiVersion, language).toBeGreaterThanOrEqual(13);
    }
  });
});
