# Changelog

All notable changes to Osnova are recorded here. The format follows Keep a Changelog, and the project uses Semantic Versioning. Before 1.0, minor versions may change the MCP and CLI contract; each such change is listed under Breaking.

## Unreleased

### Added

- `osnova mcp --watch`: a recursive file watcher marks the index stale on change and refreshes after a short debounce, so a query reuses the last verified index instead of hashing the working tree first. A verification older than 30 seconds, a change seen since it, or an unavailable watcher falls back to the per-query refresh. Changes under ignored directories such as `node_modules` and the cache directory are skipped.
- A composite GitHub Action (`action.yml`, backed by `scripts/settle-ci.sh`) that indexes the pull request base and head at the same path, runs `osnova settle`, writes the dependents of the changed symbols to the job summary and optionally posts them as a comment. The repository runs it on its own pull requests through `.github/workflows/settle.yml`.
- The README shows `plumb` checking a claimed caller list on the pinned click checkout, with the verdict semantics spelled out.
- `benchmarks/exactness/exactness-v1.json` pins five hand-verified call-site sets on public checkouts, and `scripts/exactness.mjs` compares the first regex a person would type against the resolved call graph on each; the README carries the measured table and `benchmarks/results/grep-vs-graph-2026-09-17.json` the record.
- Unresolved call edges in `osnova_warp` and `warp` carry `nameMatches`: the indexed functions, methods and classes in the same language family that share the call's name, capped at five with the total, printed as `same-name symbols (N, unverified): ...`. `plumb` prints the same count and list on `name-only` verdicts. A same-name list is a reading list, never a resolution.

### Changed

- `super.m()` in TypeScript, Java and C# (`base.m()`) and `super().m()` in Python resolve to the single declared base of the enclosing class through the heritage walk; more than one base stays unresolved. Java and C# classes record heritage. Artifact extraction version moves to `structural-9.9`.
- Go, Rust, Java and C# member calls carry receiver hints: typed parameters, typed locals, constructor literals, declared return types (including chains), struct and class fields, `this`, `self`, the Go method receiver, static access through a type name, and unqualified calls inside a Java or C# class. Methods carry `memberKind` (Go instance; Rust static or instance by `self`; Java and C# by the `static` modifier) and `returns`. Go package imports resolve through `go.mod` to the package directory with package-wide export lookup; Rust `crate::`, `super::` and `self::` paths resolve against the nearest `Cargo.toml`; Java imports resolve to `a/b/Name.java`; a type declared exactly once in the language family resolves without an import, and a type no indexed file declares counts as `unbound-global`. A member call whose receiver is unknown is now `receiver-unresolved` instead of a name-only match, so resolved counts fall where the old name heuristic guessed. Artifact extraction version moves to `structural-9.8`.
- Python class-body annotations (`conn: Conn`, `other: mod.Conn = make()`) and `@property` methods with a return annotation type the field, so `self.conn.send()` and `self.link.send()` resolve when the field is written at most once. Artifact extraction version moves to `structural-9.8`.
- Bare import specifiers resolve to workspace packages: a `package.json` `name` plus its `exports` map (every condition is tried, source files first; `*` patterns are expanded) or its `module`, `main` and `types` fields, with `src/index` and `src/<subpath>` as fallbacks. Python absolute imports resolve through every directory that holds a `pyproject.toml`, `setup.py` or `setup.cfg` and through that directory's `src` layout. Two packages with the same name stay unresolved. `node:` builtins and packages outside the repository stay `import-target-unresolved`.
- A file named `package.json` is scanned even when a repository ignore rule matches it, since a manifest is needed to map the package name; configured output and dependency directories such as `node_modules` and `dist` are still skipped.

## 0.4.0 (2026-09-17)

### Added

- `osnova_plumb` and the CLI command `plumb`: check a claimed list of `path:line` call sites for a symbol against the index. Verdicts per site are confirmed, name-only, no-call or not-indexed, plus the resolved dependents the list left out.
- `osnova coverage` and `resolutionCoverage`: call-site resolution coverage per language, by method and by reason, with the share among call sites not blocked by an unresolved import shown beside the plain share. `scripts/coverage-corpora.mjs` records it on the pinned checkouts; the README carries the measured numbers.

### Changed

- Call resolution follows `export * as name` namespace re-exports, so `name.member(...)` through a barrel resolves to the declaring symbol.
- Python parameters annotated with a class name (`ctx: Context`, `ctx: mod.Context`) act as instance receivers, so `ctx.method()` resolves to that class's method. Unions, `Optional`, string annotations and reassigned parameters stay unbound. Artifact extraction version moves to `structural-9.8`; older caches rebuild.
- TypeScript type annotations on parameters, class fields, constructor parameter properties and `const` or `let` locals act as instance receivers, and interface method signatures and function-typed property signatures are indexed as members, so `reader.read()` resolves when `reader: Reader`.
- Members are found through declared inheritance: `extends` clauses on classes and interfaces (TypeScript) and base classes (Python) are followed for up to eight hops when the receiver's own class lacks the member. `implements` clauses are not followed. The walk stays unresolved when a base cannot be identified, when two base chains supply different members, when the chain cycles, or when the class declares a non-method field of that name. Symbols carry `heritage` and `fields` lists. Type-only imports and `readonly` constructor parameter properties supply receivers; static fields, fields written more than once, and fields assigned only inside a nested function do not.
- A field assigned exactly once in the constructor from a constructor call (`this.client = new Client()`, `self.client = Client()`) acts as a receiver for `this.client.method()` and `self.client.method()`.
- TypeScript `namespace` and `module` blocks are indexed as `module` symbols with their members under them (`Uri.create` is a `function` under `Uri`), so `Uri.create()` and a call through a namespace merged with a class or interface resolve. A namespace function is reachable through the namespace name only, never through an instance. Nested namespaces resolve when the outer name is declared in the same file.
- Declared return types act as receivers: `make().hit()`, `const x = make(); x.hit()`, `this.build().hit()` and chains such as `builder().trim().make().hit()` resolve when each callee's return annotation names an indexed class or interface (TypeScript `: Foo` and `: this`, Python `-> Foo` and `-> Self`). Symbols carry `returns`. Unions, generics such as `Promise<Foo>`, string annotations, unannotated callees and reassigned locals stay unbound. A call on a value produced by an import the index cannot resolve now counts as `import-target-unresolved` rather than `receiver-unresolved`, and a call to a name with no binding in the file (a builtin or ambient global) counts as `unbound-global`; `osnova coverage` reports both counts and a share that excludes both (`resolvedShareExcludingExternal`).
- `osnova_ground` and `osnova_footing` inline whole definitions of 40 lines or fewer; the footing budget is 4096 code units; the response prefix is shorter.

### Fixed

- Cache lock recovery: a transient failure while removing the recovery marker could leave a dead lock unrecoverable until timeout, and Windows could refuse the rename while another waiter held a handle. Recovery now yields and retries, and the marker is always removed.
- The clean-install smoke retries temporary directory cleanup on Windows.
- Tool count, budgets and heritage wording in the README and reference match the shipped behavior; CLI `plumb` shares the 4,096 code-unit budget.

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
