# osnova

Deterministic repository context engine. Osnova maps a codebase into a symbol and edge graph using tree-sitter WASM, then serves it through a CLI and an MCP stdio server. No embeddings, no network, no telemetry.

- Languages v1: TypeScript, TSX, JavaScript, JSX, Python, Go, Rust, Java, C#. Every other file type gets a bare file card (path, hash, no symbols).
- Query surface: `ask`, `findText`, `findTextDetailed`, `skeleton`, `callers`, `callersDetailed`, `map`, `renderMapCard`, `indexHealth`.
- Edge semantics v1: direct calls, imports and exports, name references. No type inference and no dynamic dispatch resolution; expect per-language precision limits.
- Determinism: incremental updates produce byte-identical artifacts to full rebuilds. All paths, symbols, and edges are sorted before serialization.

## Install

```sh
npm install @getdomovoi/osnova
```

Node.js >= 22.13.0. The grammar WASMs ship in the package; there are no native builds.

## CLI

```sh
osnova build <root>            # build and cache the index
osnova ask "<question>"        # keyword search with exact file:line hits
osnova grep "<pattern>"        # regex/literal search grouped by symbol
osnova skeleton <file>         # every definition's signature and span
osnova callers <symbol>        # direct or transitive callers/callees
osnova map                     # directory clusters, hubs, hotspots
osnova check <root>            # staleness gate for CI (exit 1 when stale)
osnova mcp --workspace <path>  # MCP stdio server
```

Query commands refresh the index first (hash diff plus incremental apply), including uncommitted edits. Unavailable workspace data aborts the query; recovered syntax errors and extraction failures produce explicit partial-analysis warnings. This is not an atomic snapshot of a workspace being edited concurrently.

## MCP server

```sh
osnova mcp --workspace /path/to/repo
```

Exposes five read-only tools: `osnova_ask`, `osnova_find_text`, `osnova_skeleton`, `osnova_callers`, `osnova_map`. Arguments mirror the API. The server never writes outside the cache directory and performs no network access.

Example client configuration:

```json
{
  "mcpServers": {
    "osnova": {
      "command": "npx",
      "args": ["-y", "@getdomovoi/osnova", "mcp", "--workspace", "/path/to/repo"]
    }
  }
}
```

## API

```ts
import { buildIndex, ask, renderMapCard } from "@getdomovoi/osnova";

const index = await buildIndex("/path/to/repo");
const hits = ask(index, "where do we validate tokens", { limit: 5 });
const card = await renderMapCard(index); // <= 16,384 code units
```

Exports: `buildIndex`, `loadIndex`, `applyChanges`, `freshness`, `indexHealth`, `ask`, `findText`, `findTextDetailed`, `skeleton`, `callers`, `callersDetailed`, `map`, `renderMapCard`, index types, and the MCP stdio main (`runMcpStdio`).

### Definition retrieval

`ask` ranks individual definitions, not one first-matching line per file. Exact identifier and qualified-member matches take priority over lexical matches; separate name, signature, adjacent-documentation, path and body signals determine ordering within those tiers. Body term frequency is saturated so repeated references cannot win merely by volume. Scores are ranking values, not confidence probabilities.

Camel-case, acronym and snake-case words are searchable, while exact matching preserves whole identifier boundaries, including short names. Multiple relevant definitions from one file may appear; duplicate logical symbol IDs do not. Module-level text and prose files remain searchable as fallback documents. Body text is assigned to its innermost indexed definition rather than repeated into every enclosing class.

Excerpts retain exact source line numbers and may include an associated leading comment when it supplies the relevant evidence. Documentation recognition is bounded to adjacent comment-like lines and leading Python docstrings, including common multiline signatures; it is not a complete documentation parser. Query documents are cached per index instance and rebuilt for a new incremental index. `filesSearched` counts eligible indexed files, not only files with hits. API result limits must be nonnegative safe integers.

### Search completeness

`findTextDetailed(index, pattern)` returns every non-overlapping, line-based match in the indexed text by default. Its result includes `groups`, `totalGroups`, `totalMatches`, `omittedGroups`, `omittedMatches`, `truncated`, and `scope: "indexed-text"`. Completeness refers to indexed text, not ignored, unreadable or otherwise unindexed workspace content, and not fresh disk state unless the caller refreshed the index.

Optional `limit` and `matchesPerGroup` bound the detailed result; both must be nonnegative safe integers. Counts include matches excluded by either limit. Zero limits can hide existing matches and are reported as truncation, not absence.

The existing `findText` API retains its array result, default 50-group limit, and 10-match-per-group cap. CLI `grep` and MCP `osnova_find_text` keep those default caps but now display totals and omission notices. Their `limit` controls groups, not matches per group. Use the detailed API without limits when every indexed occurrence is required. These count limits are separate from the presentation budget below.

### Presentation budget

CLI output messages and MCP text payloads are capped at 16,384 UTF-16 code units (`maximumTextResponseCodeUnits`), excluding transport framing and the CLI's terminating newline. Diagnostics and errors use the same cap. Larger payloads include an explicit output-clipping notice with the omitted code-unit count; any query counts above that notice describe the structured selection before presentation clipping. Clipping never splits a surrogate pair. These are code-unit limits, not token estimates or limits on computation/memory use.

Structured query APIs are not subject to this text-presentation cap. Search callers needing every indexed occurrence should use `findTextDetailed` without limits. Ask output identifies excerpt ranges when a definition is not fully displayed, including its existing 400-line full-span limit. Map cards retain their elastic detail dropping and configurable nonnegative code-unit cap; zero returns an empty card.

### Caller evidence

`callersDetailed` returns `status: "ambiguous"` with candidate symbols when a bare name matches multiple definitions. Select a qualified name (`file#Class.method`) to continue. A `status: "found"` result contains the target, indexed `hits`, direction/depth, and separate `unresolved` entries carrying raw edges and traversal depth. Unresolved inbound evidence is name-based, not a confirmed caller; unresolved evidence is never traversed as a dependency.

Each detailed hit includes its original `edge`, preserving the source call-site path/line separately from the callee definition location. Extracted edges record syntax provenance and their resolution basis: `import-path`, `same-file-name`, `imported-file-name`, or `unique-name`. Name resolution remains heuristic even when its status is `resolved`. Multiple candidates at the preferred tier stay `ambiguous` with candidate names instead of selecting one arbitrarily; unrelated language families are excluded. TypeScript, TSX and JavaScript share a family. Externally supplied edges without provenance are explicitly `unknown` when serialized.

TypeScript/JavaScript and Python direct calls additionally carry lexical `binding` hints. Named imports resolve through their source module and exported name, preserving the local call-site name. Named default exports, local export aliases, direct namespace members and known local definitions are supported, with `import-binding` or `lexical-definition` evidence. Parameter, destructuring, loop, catch and assignment bindings prevent an imported name from leaking through a shadow; Python function-local assignments apply even before their textual declaration. Missing imported targets do not fall back to unrelated global names. Module-level arrow bodies are attributed to their indexed definition.

Named nested TypeScript/JavaScript definitions and constants are retained under their enclosing qualified names, including declarations inside arrow bodies. Calls from nested arrows use the nested definition's identity rather than being folded into the enclosing function.

Static named re-export chains, JavaScript/TypeScript `export *` barrels and Python named package exports are followed to their declaring symbols. Explicit exports take precedence over stars, stars do not forward `default`, and competing declarations remain ambiguous. Unknown competing wildcard paths, blocked exports and traversal-budget exhaustion are reported as `re-export-incomplete`; cycles without a resolved exit are reported as `re-export-cycle`. Successful chains carry `re-export-binding` evidence with a deterministic representative `via` path of export sites. These hops describe module export names, not additional definition IDs.

Export lookup is bounded to 4,096 `(module, export-name)` states and 128 forwarding hops per requested export, with per-index-resolution memoization. Links persist in `FileCard.reExports`, so changing a barrel re-resolves unchanged clients. Python relative module paths are normalized within the indexed root, and a package initializer takes precedence over a same-name module file.

This is declaration-aware analysis of static export syntax, not execution, compiler validation or type inference. Rebinding conflicts, type-only runtime calls, Python wildcard imports, `global`/`nonlocal` and match scopes are conservative; CommonJS export assignments, exported namespace objects, anonymous defaults and dynamic receiver/value flow remain unsupported by this binding pass. Ordinary member calls can still use the older documented name heuristic. Missing local definitions and blocked bindings remain explicit unresolved evidence.

CLI `callers` and MCP `osnova_callers` use this detailed behavior with their existing arguments. The legacy `callers` API retains its deterministic selection and result shape. Detailed queries require a positive safe-integer depth. Neither a graph hit nor an empty result proves runtime behavior: current resolution is heuristic, not type inference, and missing callers do not establish that deletion is safe.

### Index health

`await indexHealth(index)` returns a state, all diagnostics, and a freshness report (or `null` when freshness cannot be checked). States are `fresh`, `stale`, `partial`, and `unavailable`. Disk changes take precedence over partial analysis in the state; diagnostics remain present in either case. Fresh means unchanged indexed inputs and no recorded extraction failures, not complete semantic understanding of every language or file.

Syntax-recovered files retain their text and recovered definitions with `syntax-errors` diagnostics. Extractor failures retain text with `extraction-failed` diagnostics. Missing grammars, unreadable ignore files, directories, file stats or file contents stop indexing/refresh rather than silently removing data. Operational failures use `IndexingError` with a structured `diagnostic` and the underlying error as `cause`.

CLI queries emit partial-analysis warnings on stderr; MCP results include warnings in their text. Map cards keep the health indication inside their existing code-unit cap. `osnova check` exits 1 for stale, partial, or unavailable indexes, and 0 only for fresh indexes. Full builds may save partial indexes so text search and recovered definitions remain available.

Artifact format 6 persists diagnostics, export names, re-export links, lexical bindings and resolution evidence. `loadIndex` returns `undefined` for format-1 through format-5 caches, which predate current analysis guarantees; query commands rebuild them. Corrupt or unsupported newer artifacts and failed cache writes remain explicit errors. Repaired files clear their old diagnostics on incremental update.

Cache location: explicit `cacheDir` parameter, else `OSNOVA_CACHE_DIR`, else the platform default (macOS `~/Library/Caches/osnova/`, Linux `$XDG_CACHE_HOME/osnova/`, Windows `%LOCALAPPDATA%/osnova/cache/`). One subdirectory per workspace, LRU-evicted across workspaces.

Scanning currently reads root-level `.gitignore` plus an optional root-level `.osnovaignore` with the same syntax, skips dotfiles and configured output/dependency directories, and excludes files above 1 MB. Binary files get fallback cards with empty text rather than searchable contents. Nested ignore rules are not yet supported.

## Development

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm perf
```

The perf script enforces first-build and incremental-refresh budgets on a generated fixture repo. Tests include per-language extraction goldens, an incremental-equals-full property test over randomized edit sequences, CLI round-trips, and MCP handshake plus tool round-trips over an in-memory transport.

### Reproducible benchmarks

```sh
pnpm benchmark --samples 5 --output /existing/directory/candidate.json
pnpm benchmark --split evaluation --samples 5 --candidate-report /existing/directory/candidate.json
pnpm benchmark --manifest /path/to/corpus.json --workspace /path/to/checkout --output /existing/directory/result.json
```

The default `benchmarks/core-v1.json` is a small authored regression corpus, not representative evidence for large repositories. It separates development cases from explicitly selected evaluation cases. Evaluation labels are public and versioned, not a sealed test set. Freeze changes before evaluating; do not tune against evaluation scores. Corpus content and labels have a stable SHA-256 fingerprint, and each run also records input-snapshot, engine and harness fingerprints.

Evaluation commands require `--candidate-report` from a completed development run over the same corpus. Engine, harness, manifest, runtime environment and complete development case set must match; the input snapshot is checked before indexing or executing evaluation queries. The evaluation result carries a receipt identifying that candidate. Code, harness, labels or runtime changes require another development run. This is a local reproducibility guard, not a cryptographic signature, proof of task success, or a way to make public labels secret.

Additional source-pinned workloads are `benchmarks/zod-v1.json` (TypeScript), `benchmarks/click-v1.json` (Python), and `benchmarks/pyright-v1.json` (a TypeScript monorepo with Python test inputs). Their source repository and immutable revision are recorded in each manifest. They are small task sets over full checkouts, not comprehensive language coverage. Supply a clean checkout at that revision with `--workspace`; merely validating a manifest is not a measured benchmark result.

The runner launches a fresh process using `tsx` source execution, writes only into a disposable copy/cache and an explicitly requested result file, and runs no workload installation or test scripts. It never downloads a checkout. External corpus manifests require a full 40-character Git revision, a matching clean checkout with no untracked files, and source anchors independent of the extractor. Tracked files are copied independently of Osnova's scanner; symlink/submodule inputs are rejected. The supplied checkout is not edited. Output files are created exclusively, never overwritten.

A checkout manifest may declare `source.exclude` as exact relative files or directory prefixes, without glob syntax. Exclusions must match tracked input and cannot cover the edit file, source anchors, expected-result files, or the query target/scope. They are included in the manifest fingerprint and reported with the exact omitted paths as `snapshotExclusions`. The Zod workload excludes four enumerated agent-config/documentation symlinks; this does not relax the regular-file check for other inputs or follow symlinks.

Reports include raw expected/actual IDs, errors, source-validation failures, per-case latency and bounded text payloads. Metrics score **structured query results**, not what an agent can reconstruct from clipped text. Retrieval uses Recall@5 and reciprocal rank at 5; duplicate hits consume ranking positions. Caller precision/recall score distinct direct-call symbols by default, excluding reference/import edges, with traversal depth available per case. Text-search IDs use `file:line:column`, with one-based lines and zero-based columns. Correct empty sets score 1; unexpected results on empty ground truth score precision 0. Query errors remain in the aggregate denominator as zero; invalid source anchors invalidate that metric aggregate instead of disappearing from it.

Timing separates first build, unchanged hash refresh, and edited refresh including hash diff, incremental apply and cache write. Edit/revert setup and full-rebuild equivalence checks are outside the timed refresh samples. Percentiles use nearest rank; small sample counts provide only coarse smoke measurements. First build is process-cold for the parser, not a flushed filesystem-cache or process-startup measurement. Peak RSS includes the worker runtime and `tsx`, not just the graph. Serialized and on-disk artifact sizes are reported separately.

Agent task success, tokenizer-based context counts, agent tool calls and packed-package size remain `null` until measured by their own trials. `status: completed` means measurement finished, not that retrieval was perfect; inspect the scores. Operational/query failures produce `status: failed` and command exit 2. This benchmark does not replace `pnpm perf` or the unit-test gates.

The [initial development baseline](benchmarks/results/development-baseline-2026-09-14.json) records measured workload fingerprints, quality scores, refresh samples and limitations. It preserves misses rather than presenting successful execution as successful retrieval. Evaluation cases remain separate and were not used for that baseline.

The [definition-ranking candidate](benchmarks/results/definition-ranking-2026-09-14.json) records its frozen development/evaluation results and receipts. It improved retrieval on the small task sets, but preserves unresolved alias-caller misses and reports increased first-query costs. These results are not agent task-success claims.

The [import-binding and scoped-declaration results](benchmarks/results/import-bindings-2026-09-14.json) record two separately frozen candidates, the nested-coverage regression found between them, and the corrected outcome. Exposed cases are labeled as regressions rather than reused as fresh validation.

The [re-export results](benchmarks/results/reexports-2026-09-14.json) retain the frozen candidate receipt, positive and negative cases, development regressions and traversal limits. Self-host tests also verify callers through the public API barrel.

## License

Apache-2.0
