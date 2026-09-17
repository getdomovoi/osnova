# Changelog

All notable changes to Osnova are recorded here. The format follows Keep a Changelog, and the project uses Semantic Versioning. Before 1.0, minor versions may change the MCP and CLI contract; each such change is listed under Breaking.

## Unreleased

### Added

- `osnova_plumb` and the CLI command `plumb`: check a claimed list of `path:line` call sites for a symbol against the index. Verdicts per site are confirmed, name-only, no-call or not-indexed, plus the resolved dependents the list left out.
- `osnova coverage` and `resolutionCoverage`: call-site resolution coverage per language, by method and by reason, with the share among call sites not blocked by an unresolved import shown beside the plain share. `scripts/coverage-corpora.mjs` records it on the pinned checkouts; the README carries the measured numbers.

### Changed

- Call resolution follows `export * as name` namespace re-exports, so `name.member(...)` through a barrel resolves to the declaring symbol.
- Python parameters annotated with a class name (`ctx: Context`, `ctx: mod.Context`) act as instance receivers, so `ctx.method()` resolves to that class's method. Unions, `Optional`, string annotations and reassigned parameters stay unbound. Artifact extraction version moves to `structural-9.3`; older caches rebuild.
- TypeScript type annotations on parameters, class fields, constructor parameter properties and `const` or `let` locals act as instance receivers, and interface method signatures and function-typed property signatures are indexed as members, so `reader.read()` resolves when `reader: Reader`.
- Members are found through declared inheritance: `extends` and `implements` clauses on classes and interfaces (TypeScript) and base classes (Python) are followed for up to eight hops when the receiver's own class lacks the member. Symbols carry a `heritage` list.
- A field assigned exactly once in the constructor from a constructor call (`this.client = new Client()`, `self.client = Client()`) acts as a receiver for `this.client.method()` and `self.client.method()`.
- `osnova_ground` and `osnova_footing` inline whole definitions of 40 lines or fewer; the footing budget is 4096 code units; the response prefix is shorter.

## 0.3.0 (2026-09-17)

### Added

- `osnova --version`.
- `osnova setup --preview --client <name>`: a unified diff against the client's real global config (Claude Code, Codex, OpenCode, Kilo, Cursor, Pi) that adds the one `osnova` entry and nothing else. Read-only. Reports unchanged or conflict when an entry exists.
- `SECURITY.md`, issue templates and a private security report link.

### Changed

- `osnova_warp` accepts `Class.method` without the file prefix when it names one symbol; several matches come back as an ambiguous candidate list as before. Errors from `warp` and `outline` now name `thread` and `ground` instead of a retired tool.
- `osnova_settle` accepts a diff whose hunks are short by the same number of old and new lines, which can only be dropped context, and records `diff-short-by-N-context-lines-treated-as-unchanged` in its notes. A hunk short on one side only is still rejected, now with the hunk line and the missing counts.
- `osnova_settle` on a large repository dropped from about 2 s to under 50 ms; `osnova_footing` on a warm index from about 0.4 s to 0.37 s. Both walk edges in artifact order instead of sorting by a canonical JSON key.
- Search keeps plain sentence words out of the exact-identifier tier, so a prose question no longer promotes tiny symbols named after common words. Words still enter that tier when they look like identifiers, are quoted, or are the whole query. Recall and reciprocal rank are unchanged on every benchmark corpus.
- `osnova_footing` seeds from definition hits only and overfetches so prose files never crowd out code.

## 0.2.0

First public release.

### Added

- MCP stdio server with seven read-only tools: `osnova_ground` (keyword search), `osnova_thread` (text search), `osnova_outline` (one file's signatures), `osnova_warp` (call graph), `osnova_groundwork` (repository map), `osnova_footing` (task context) and `osnova_settle` (change impact for a unified diff).
- CLI with the same seven commands plus `build`, `check`, `doctor` and `mcp`. `osnova mcp` defaults to the current directory so one global client entry serves every repository.
- Deterministic index: incremental refresh produces the same bytes as a full rebuild. Artifact format 9 with a verified structural core, lazily loaded edges and lazily read source text.
- Deep adapters for TypeScript, JavaScript, Python, Go, Rust, Java and C#, with lexical import bindings, re-export chains and receiver hints for TypeScript, JavaScript and Python. Generic definition and call extraction for C, C++, Ruby, PHP, Kotlin, Swift, Scala, Dart, Elixir, OCaml, Zig and Bash.
- Every response carries an index generation, exact omission counts and a one-line foundation state when the index is partial.
- Library API: `buildIndex`, `loadIndex`, `refreshWorkspace`, `ask`, `askDetailed`, `findText`, `findTextDetailed`, `skeleton`, `callers`, `callersDetailed`, `map`, `renderMapCard`, `scopedAsk`, `taskContext`, `impact`, `indexHealth`, `doctor`, optional LSP enrichment and `runMcpStdio`.
- Reproducible benchmark harness with frozen corpora and recorded results, including rejected experiments.

### Breaking

- Pre-release tool names (`osnova_ask`, `osnova_find_text`, `osnova_skeleton`, `osnova_callers`, `osnova_map`) and CLI commands (`ask`, `scoped-ask`, `grep`, `skeleton`, `callers`, `map`, `context`, `impact`) are not accepted. Nothing shipped under them.
- `setup --preview` and the `previewSetup` API are removed. Per-client configuration previews return in a later release.
