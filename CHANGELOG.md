# Changelog

All notable changes to Osnova are recorded here. The format follows Keep a Changelog, and the project uses Semantic Versioning. Before 1.0, minor versions may change the MCP and CLI contract; each such change is listed under Breaking.

## Unreleased

### Added

- `benchmarks/exactness/exactness-v1.json` gains four hand-verified call-site sets on ripgrep (`Searcher.line_terminator`, `LineTerminator.as_byte`) and gson (`JsonReader.beginObject`, `TypeToken.getRawType`), so the grep-versus-graph table covers Go, Rust and Java as well as Python and TypeScript; `benchmarks/results/grep-vs-graph-2026-09-18.json` records all nine on the released 0.6.0 code, including the two sets where the text search beats the graph on recall.

## 0.6.0 (2026-09-18)

### Added

- A function or method with no return annotation whose every own return is `new Foo()` (TypeScript and JavaScript), `Foo()` (Python) or `this` records that result as `returns`; an `async` one records it as `unwrapped`. Returns that disagree, a bare `return`, a generator, or a return inside a nested function leave it unknown. `const service = createAnalyzer(); service.setOptions(..)` resolves when `createAnalyzer` ends in `return new AnalyzerService(..)` (pyright +100 sites).

- `osnova hook prompt`, `osnova hook session` and `osnova hook stop`: Claude Code hooks that read the payload on stdin. `prompt` prints starting points for the prompt (definitions and relationships from `footing`, callable and holder kinds only, under 1,024 code units); `session` prints the tool contract and the index size; `stop` diffs the worktree against `HEAD` and, once per stop, returns a `block` decision whose reason lists the indexed dependents of the changed symbols (under 1,536 code units), so the agent checks them before it finishes (`OSNOVA_HOOK_SETTLE=off` disables it). A repository with no cache is indexed in the background by the session hook; the prompt and stop hooks answer only from an existing cache. Nothing is printed on a slash command, a prompt under twelve characters, or any failure, and every hook exits 0. `osnova hook install-preview` prints the settings snippet. The CLI wrapper now carries a caller-supplied stdin reader through to commands.
- `osnova setup --apply` writes what `--preview` shows: the MCP entry for any client, `--hooks` for the three Claude Code hook groups in `~/.claude/settings.json` (added only when no group already runs that `osnova hook <event>`; other keys and the file's indent are kept), and `--instructions <file>` for a tool-contract block appended once between `<!-- osnova:start -->` and `<!-- osnova:end -->` markers. Every changed file is backed up first as `<file>.bak-osnova-<stamp>`, a second run reports `unchanged` and writes nothing, and one conflict stops the whole apply before any write.
- The MCP server sends the tool contract as `instructions` on initialize, so every client that honours MCP instructions carries it in the system prompt without a hook.
- `osnova hook --client codex` answers with `additionalContext` JSON and `--client cursor` answers the stop hook with a `followup_message`; `osnova setup --apply --hooks --client codex|cursor` writes `~/.codex/hooks.json` (session, prompt, stop) and `~/.cursor/hooks.json` (stop only, since Cursor's prompt hook cannot add context). `osnova setup --apply --plugin --client opencode|kilo|pi` copies the shipped `integrations/opencode/osnova.js` plugin or `integrations/pi/osnova.ts` extension into the client's plugin directory; both shell out to `osnova hook` for the contract and starting points (`OSNOVA_BIN` overrides the executable) and are never overwritten once present.
- `osnova doctor` reads `~/.claude/settings.json` and `~/.claude.json`, runs `--version` on every osnova hook and MCP command they configure, and warns when one reports another version than the doctor itself (`client:hook`, `client:mcp` checks).
- Hooks and `osnova mcp` without `--workspace` resolve the workspace to the git top level of the starting directory, so a client started in a subdirectory indexes the repository.

### Changed

- Artifact extraction version moves to `structural-9.17`, so caches built by 0.5.0 are rebuilt with the Python `None` union handling and the constructor-literal return inference.
- Measured hook latency on the pinned pyright checkout (7,653 files): the prompt hook answers in about 1.5 s from a warm cache (most of it verifying file hashes), the session hook in 0.4 s, the stop hook on a clean tree in 0.2 s, and the first build takes 6 s in the background. No shared warm process yet; the numbers did not call for one.
- Python `X | None`, `None | X`, `Optional[X]`, `t.Optional[X]` and `Union[X, None]` name `X` in parameter, return, field and collection annotations, as TypeScript already strips `null` and `undefined`; a union of two or more real types names no receiver. Overloads that differ only by `| None` now agree, so `get_current_context()` in click binds its result and the `ctx.invoke` sites in `decorators.py` resolve (click 38.2% to 38.5%).
- `eslint` ignores `.claude/**`, so the publish gate runs unaided next to agent-installed helpers, and `bin` points at `dist/bin.js` without the leading `./` that npm normalized with a warning.

## 0.5.0 (2026-09-18)

### Fixed

- A receiver chain nested deeper than eight owners (field and element chains such as `state.workspace.service.clone().getConfigOptions().executionEnvironments[0].extraPaths[0].toString()` in pyright) was written to `edges.json` but rejected by the cache validator on the next load, so every query in a fresh process failed with `cache-read-failed` while the process that built the index still answered. Extraction now caps owner nesting at twelve (the resolver follows six hops) and the validator accepts sixteen. Artifact extraction version moves to `structural-9.16` so affected caches rebuild.

### Added

- `osnova_warp` and `warp` no longer repeat a relationship's own `file:line` as `source file:line` on `in` results (every `in` site is its own source); `out` results keep the suffix because the site and the target differ. About 40 code units per relationship inside the unchanged 2,048 budget.
- `scripts/coverage-corpora.mjs` loads every corpus back from the cache it just wrote, decodes the edges and re-measures coverage on the reloaded index, so a binding shape the serializer accepts but the validator rejects fails the measurement instead of a fresh MCP process. The record carries `cacheRoundTrip` per corpus. On the code before #42 the pyright corpus fails this check with `cache-read-failed`.
- `osnova mcp --watch`: a recursive file watcher marks the index stale on change and refreshes after a short debounce, so a query reuses the last verified index instead of hashing the working tree first. A verification older than 30 seconds, a change seen since it, or an unavailable watcher falls back to the per-query refresh. Changes under ignored directories such as `node_modules` and the cache directory are skipped.
- A composite GitHub Action (`action.yml`, backed by `scripts/settle-ci.sh`) that indexes the pull request base and head at the same path, runs `osnova settle`, writes the dependents of the changed symbols to the job summary and optionally posts them as a comment. The repository runs it on its own pull requests through `.github/workflows/settle.yml`.
- The README shows `plumb` checking a claimed caller list on the pinned click checkout, with the verdict semantics spelled out.
- `benchmarks/exactness/exactness-v1.json` pins five hand-verified call-site sets on public checkouts, and `scripts/exactness.mjs` compares the first regex a person would type against the resolved call graph on each; the README carries the measured table and `benchmarks/results/grep-vs-graph-2026-09-17.json` the record.
- Unresolved call edges in `osnova_warp` and `warp` carry `nameMatches`: the indexed functions, methods and classes in the same language family that share the call's name, capped at five with the total, printed as `same-name symbols (N, unverified): ...`. `plumb` prints the same count and list on `name-only` verdicts. A same-name list is a reading list, never a resolution.

### Changed

- A receiver chain that ends on a type no indexed file declares (`s.names[0].trim()` on `string[]`, `map.get(k).trim()`, `label().trim()` on `(): string`, a Rust `&str` or `u32` parameter, a Go `[]string` element) now classifies as `unbound-global`, and one that ends on a type behind an unresolved import as `import-target-unresolved`, so both leave the excluding-externals denominator instead of counting as `receiver-unresolved`. A chain that ends on a type parameter of an enclosing declaration stays unresolved (a parser-recovered type parameter list is ignored). TypeScript primitive annotations (`string`, `number`, `boolean`, `symbol`, `bigint`) bind as builtin receivers; `any` and `unknown` stay unknown. Rust `Box<T>`, `Rc<T>`, `Arc<T>`, `&T` and `dyn Trait` bind the pointee, so a call through a boxed trait object resolves to the trait method. Go `new(pkg.T)` constructs a `pkg.T` through the import.
- Collections carry their contents: class and interface symbols record `elementTypes` (`Foo[]`, `Array<Foo>`, `Set<Foo>`, `Iterable<Foo>`, `list[Foo]`, `Sequence[Foo]`) and `valueTypes` (`Map<K, Foo>`, `Record<K, Foo>`, `dict[K, Foo]`, `Mapping[K, Foo]`) per field, and functions record `elements` and `values` for a returned collection. `for (const x of xs)`, `for x in xs`, comprehensions, `xs.forEach((x) => ..)`, `xs.map/filter/some/every/find/flatMap((x) => ..)`, `xs[i]`, `map.get(k)`, `map.forEach((v, k) => ..)`, `map.values()` and `xs.filter(..).slice(..)` pass-throughs bind the element or value; a local that aliases a member chain (`const list = store.items`) or an indexed element takes that owner. A collection bound by an alias, a destructured loop variable, a Map iterated directly with `for..of`, and builtin functions such as `sorted(xs)` stay unresolved. Go, Rust, Java and C# record the same tables from `[]T`, `map[K]V`, `Vec<T>`, `HashMap<K, V>`, `&[T]`, `List<T>`, `Map<K, V>`, `T[]`, `Dictionary<K, V>`, `IEnumerable<T>` and friends; `for _, x := range xs` (the second range variable), Rust `for x in &xs` and `xs.iter()`, Java enhanced `for` and `xs.forEach(x -> ..)` or `xs.stream().filter(x -> ..)`, C# `foreach` and `xs.ForEach(c => ..)` or LINQ `Where`, `Select` and `Any` lambdas, `xs[i]`, `m[k]`, `list.get(i)`, `map.get(k)` and `HashMap::get(k).unwrap()` bind the element or value the same way. Artifact extraction version moves to `structural-9.15`.
- Functions and methods carry `unwrapped`: the value type inside a `Promise<T>` or `PromiseLike<T>` return annotation (TypeScript), an async function's declared result (Python), or the first type argument of a `Result` or `Option` return type (Rust, including `io::Result<T>`). `await f()`, `const x = await f()`, `f()?`, `let x = f()?;`, `f().unwrap()` and `f().expect(..)` then resolve calls on the inner value; `f().m()` without the unwrap still does not. Artifact extraction version moves to `structural-9.13`.
- `import * as ns from "./x"; export { ns }` (and `export { ns as default }`) is recorded as a namespace re-export, so `import { z } from "zod"; z.string()` resolves through the barrel, and a call on the result of a namespace member (`ns.make().m()`) follows that export's declared return type. A type position (return annotation, heritage clause, field or parameter annotation) now names the interface or type when a const shares its name, so `function number(): ZodNumber` binds to the `ZodNumber` interface next to `const ZodNumber`. Overload declarations reached through an export map must agree on the return type, as same-file overloads already had to. On the pinned zod checkout this resolves 3874 more call sites (30.4% to 37.6%).
- Field chains resolve: class, interface and struct symbols carry `fieldTypes` (the declared type of each typed field as a local or import binding), and a member call on a field of an identified receiver (`this.pool.conn.send()`, `param.field.m()`, `make().field.m()`, Go `s.pool.Conn.Hit()`, Rust `self.rdr.fill()`, Java and C# `this.pool.conn.hit()`) follows the holder's field type, across files and through the single-base heritage walk. On the pinned checkouts this resolves 964 more call sites in pyright and 250 more in ripgrep. Artifact extraction version moves to `structural-9.12`.
- A generic instantiation or an array names its base type as the receiver (`Wrapper<Foo>` is a `Wrapper`, `Foo[]` is an `Array`, `list[Foo]` is a `list`, `Vec<T>` is a `Vec`) in every language with receiver hints, so user generics resolve and builtin containers count as `unbound-global`; a type name no indexed file declares is external for TypeScript and Python too. Go methods on generic pointer receivers are indexed. Artifact extraction version moves to `structural-9.11`.
- Go functions and methods with a multi-value result list carry `returnTuple`, and `a, b := f()` binds each name to its position, so `cmd, err := c.Traverse(args)` followed by `cmd.Root()` resolves. Artifact extraction version moves to `structural-9.10`.
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
