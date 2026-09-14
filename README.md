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

### Search completeness

`findTextDetailed(index, pattern)` returns every non-overlapping, line-based match in the indexed text by default. Its result includes `groups`, `totalGroups`, `totalMatches`, `omittedGroups`, `omittedMatches`, `truncated`, and `scope: "indexed-text"`. Completeness refers to indexed text, not ignored, unreadable or otherwise unindexed workspace content, and not fresh disk state unless the caller refreshed the index.

Optional `limit` and `matchesPerGroup` bound the detailed result; both must be nonnegative safe integers. Counts include matches excluded by either limit. Zero limits can hide existing matches and are reported as truncation, not absence.

The existing `findText` API retains its array result, default 50-group limit, and 10-match-per-group cap. CLI `grep` and MCP `osnova_find_text` keep those default caps but now display totals and omission notices. Their `limit` controls groups, not matches per group. Use the detailed API without limits when every indexed occurrence is required. These are count limits, not byte or token budgets.

### Caller evidence

`callersDetailed` returns `status: "ambiguous"` with candidate symbols when a bare name matches multiple definitions. Select a qualified name (`file#Class.method`) to continue. A `status: "found"` result contains the target, indexed `hits`, direction/depth, and separate `unresolved` entries carrying raw edges and traversal depth. Unresolved inbound evidence is name-based, not a confirmed caller; unresolved evidence is never traversed as a dependency.

Each detailed hit includes its original `edge`, preserving the source call-site path/line separately from the callee definition location. Extracted edges record syntax provenance and their resolution basis: `import-path`, `same-file-name`, `imported-file-name`, or `unique-name`. Name resolution remains heuristic even when its status is `resolved`. Multiple candidates at the preferred tier stay `ambiguous` with candidate names instead of selecting one arbitrarily; unrelated language families are excluded. TypeScript, TSX and JavaScript share a family. Externally supplied edges without provenance are explicitly `unknown` when serialized.

CLI `callers` and MCP `osnova_callers` use this detailed behavior with their existing arguments. The legacy `callers` API retains its deterministic selection and result shape. Detailed queries require a positive safe-integer depth. Neither a graph hit nor an empty result proves runtime behavior: current resolution is heuristic, not type inference, and missing callers do not establish that deletion is safe.

### Index health

`await indexHealth(index)` returns a state, all diagnostics, and a freshness report (or `null` when freshness cannot be checked). States are `fresh`, `stale`, `partial`, and `unavailable`. Disk changes take precedence over partial analysis in the state; diagnostics remain present in either case. Fresh means unchanged indexed inputs and no recorded extraction failures, not complete semantic understanding of every language or file.

Syntax-recovered files retain their text and recovered definitions with `syntax-errors` diagnostics. Extractor failures retain text with `extraction-failed` diagnostics. Missing grammars, unreadable ignore files, directories, file stats or file contents stop indexing/refresh rather than silently removing data. Operational failures use `IndexingError` with a structured `diagnostic` and the underlying error as `cause`.

CLI queries emit partial-analysis warnings on stderr; MCP results include warnings in their text. Map cards keep the health indication inside their existing code-unit cap. `osnova check` exits 1 for stale, partial, or unavailable indexes, and 0 only for fresh indexes. Full builds may save partial indexes so text search and recovered definitions remain available.

Artifact format 3 persists diagnostics and resolution evidence. `loadIndex` returns `undefined` for format-1 and format-2 caches, which predate current analysis guarantees; query commands rebuild them. Corrupt or unsupported newer artifacts and failed cache writes remain explicit errors. Repaired files clear their old diagnostics on incremental update.

Cache location: explicit `cacheDir` parameter, else `OSNOVA_CACHE_DIR`, else the platform default (macOS `~/Library/Caches/osnova/`, Linux `$XDG_CACHE_HOME/osnova/`, Windows `%LOCALAPPDATA%/osnova/cache/`). One subdirectory per workspace, LRU-evicted across workspaces.

Scanning currently reads root-level `.gitignore` plus an optional root-level `.osnovaignore` with the same syntax, skips dotfiles and configured output/dependency directories, and excludes files above 1 MB. Binary files get fallback cards with empty text rather than searchable contents. Nested ignore rules are not yet supported.

## Development

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm perf
```

The perf script enforces first-build and incremental-refresh budgets on a generated fixture repo. Tests include per-language extraction goldens, an incremental-equals-full property test over randomized edit sequences, CLI round-trips, and MCP handshake plus tool round-trips over an in-memory transport.

## License

Apache-2.0
