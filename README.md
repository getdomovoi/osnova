# osnova

Deterministic repository context engine. Osnova maps a codebase into a symbol and edge graph using tree-sitter WASM, then serves it through a CLI and an MCP stdio server. No embeddings, no network, no telemetry.

- Languages v1: TypeScript, TSX, JavaScript, JSX, Python, Go, Rust, Java, C#. Every other file type gets a bare file card (path, hash, no symbols).
- Query surface: `ask`, `findText`, `skeleton`, `callers`, `map`, `renderMapCard`.
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

Query commands refresh the index first (hash diff plus incremental apply), so answers always describe current disk state, including uncommitted edits.

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

Exports: `buildIndex`, `loadIndex`, `applyChanges`, `freshness`, `ask`, `findText`, `skeleton`, `callers`, `map`, `renderMapCard`, index types, and the MCP stdio main (`runMcpStdio`).

Cache location: explicit `cacheDir` parameter, else `OSNOVA_CACHE_DIR`, else the platform default (macOS `~/Library/Caches/osnova/`, Linux `$XDG_CACHE_HOME/osnova/`, Windows `%LOCALAPPDATA%/osnova/cache/`). One subdirectory per workspace, LRU-evicted across workspaces.

Scanning respects `.gitignore` plus an optional `.osnovaignore` file with the same syntax, skips dotfiles, binaries, and files above 1 MB.

## Development

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm perf
```

The perf script enforces first-build and incremental-refresh budgets on a generated fixture repo. Tests include per-language extraction goldens, an incremental-equals-full property test over randomized edit sequences, CLI round-trips, and MCP handshake plus tool round-trips over an in-memory transport.

## License

Apache-2.0
