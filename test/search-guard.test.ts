import { describe, expect, it } from "vitest";
import { parseSearchCall, symbolHuntNames } from "../src/cli/search-guard.js";

const bash = (command: string) => parseSearchCall("Bash", { command });

describe("parseSearchCall reads a repository search out of a tool call", () => {
  it.each([
    ['rg -n "refreshWorkspace" src', ["refreshWorkspace"], ["src"]],
    ["rg refreshWorkspace", ["refreshWorkspace"], []],
    ['grep -rn "def foo\\|foo(" .', ["def foo\\|foo("], ["."]],
    ["grep -n foo src/a.ts", ["foo"], ["src/a.ts"]],
    ["rg -e foo -e bar src", ["foo", "bar"], ["src"]],
    ["rg -t ts foo lib", ["foo"], ["lib"]],
    ["rg --type=ts -i foo", ["foo"], []],
    ['rg -n "foo" src | head -20', ["foo"], ["src"]],
    ["rg -n foo src 2>/dev/null | sort | uniq -c", ["foo"], ["src"]],
    ["env LC_ALL=C rg foo src", ["foo"], ["src"]],
    ["time grep -rn foo src", ["foo"], ["src"]],
    ["git grep -n foo", ["foo"], []],
    ["bash -lc 'rg -n foo src'", ["foo"], ["src"]],
    ['sh -c "grep -rn foo ."', ["foo"], ["."]],
    ["cd sub && rg foo", ["foo"], []],
  ])("%s", (command, patterns, paths) => {
    const call = bash(command);
    expect(call?.patterns).toEqual(patterns);
    expect(call?.paths).toEqual(paths);
  });

  it.each([
    ["cat a.ts | grep foo", "a pipe filter searches another command's output"],
    ["grep foo", "grep with no file reads stdin"],
    ["rg foo $DIR/src", "a variable path cannot be resolved"],
    ["rg foo `pwd`", "a command substitution cannot be resolved"],
    ["rg -f patterns.txt src", "patterns from a file are unknown"],
    ["echo . | xargs rg foo", "xargs supplies paths from stdin"],
    ["rg -n foo src && sed -n 1,5p src/a.ts", "the command does other work besides searching"],
    ["rg foo src; rg bar lib", "two searches in one command"],
    ["ls src", "no search at all"],
    ["find . -name '*.ts'", "find lists files, it does not search text"],
  ])("%s is not a guarded search: %s", (command) => {
    expect(bash(command)).toBeNull();
  });

  it("reads the Grep tool", () => {
    expect(parseSearchCall("Grep", { pattern: "foo", path: "src" })).toMatchObject({ patterns: ["foo"], paths: ["src"] });
    expect(parseSearchCall("Grep", { pattern: "foo" })).toMatchObject({ patterns: ["foo"], paths: [] });
    expect(parseSearchCall("Grep", {})).toBeNull();
    expect(parseSearchCall("Read", { file_path: "a.ts" })).toBeNull();
  });
});

describe("symbolHuntNames keeps only patterns that are nothing but code names", () => {
  it.each([
    ["refreshWorkspace", ["refreshWorkspace"]],
    ["\\brefreshWorkspace\\b", ["refreshWorkspace"]],
    ["def foo\\|foo(", ["foo"]],
    ["function refreshWorkspace|refreshWorkspace\\(", ["refreshWorkspace"]],
    ["\\.invoke\\(", ["invoke"]],
    ["class Binder", ["Binder"]],
    ["_bindIf|visitIf|_bindConditional", ["_bindConditional", "_bindIf", "visitIf"]],
    ["self._unreachableFlowNode", ["_unreachableFlowNode"]],
  ])("%s", (pattern, names) => {
    expect(symbolHuntNames([pattern])).toEqual(names);
  });

  it.each(["cache miss", "foo.*bar", "import .* from", "TODO: fix", "a|b", "\"unreachableCode\"", "reportUnreachable|unreachable code"])("%s is text, not a hunt", (pattern) => {
    expect(symbolHuntNames([pattern])).toBeNull();
  });

  it("needs every -e pattern to be a name", () => {
    expect(symbolHuntNames(["foo", "bar"])).toEqual(["bar", "foo"]);
    expect(symbolHuntNames(["foo", "some text"])).toBeNull();
  });
});
