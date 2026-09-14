import { describe, expect, it } from "vitest";
import { getParser, loadLanguage, probeGrammars } from "../src/grammar/loader.js";
import { languageForPath } from "../src/grammar/languages.js";

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
