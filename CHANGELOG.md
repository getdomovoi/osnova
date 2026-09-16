# Changelog

All notable changes to Osnova are recorded here. The format follows Keep a Changelog, and the project uses Semantic Versioning. Before 1.0, minor versions may change the MCP and CLI contract; each such change is listed under Breaking.

## Unreleased

### Added

- `osnova --version`.
- `SECURITY.md`, issue templates and a private security report link.

### Changed

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
