<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/getdomovoi/osnova/main/assets/brand/banner-dark.png">
  <img alt="osnova. A deterministic code map for AI coding agents. Seven tools: ground, thread, outline, warp, groundwork, footing, settle." src="https://raw.githubusercontent.com/getdomovoi/osnova/main/assets/brand/banner-light.png" width="1200">
</picture>

# Osnova

**A deterministic code map for AI coding agents.** Osnova indexes a repository into a symbol and call graph with tree-sitter, then serves it to any MCP client or from the command line. Same input, same output, byte for byte. No embeddings, no network, no telemetry.

*Osnova* is the Slavic word for base or foundation. That is the job: give an agent solid ground to stand on before it edits code.

```sh
npx -y @getdomovoi/osnova mcp --workspace /path/to/repo
```

## Why Osnova

- **Exact answers.** Every hit carries a `file:line` span, a source hash and an index generation. An agent can cite it and you can check it.
- **Deterministic by design.** Incremental refresh produces the same bytes as a full rebuild. Paths, symbols and edges are sorted before they are written. Runs are reproducible.
- **Honest about limits.** Results state what was omitted and why. Partial indexes say so on every response. Absence of a caller never claims deletion is safe.
- **Local and read-only.** One cache directory, no writes inside your repository, no per-agent files to keep in sync, no network access, no usage reporting.
- **Refreshes as you type.** Query commands hash the working tree first and apply only what changed, uncommitted edits included.
- **Nineteen languages.** Deep adapters for TypeScript, JavaScript, Python, Go, Rust, Java and C#. A generic tier for C, C++, Ruby, PHP, Kotlin, Swift, Scala, Dart, Elixir, OCaml, Zig and Bash. Grammars ship as WASM, so there is nothing to compile.

## Quick start

Node.js 22.13 or newer.

```sh
npm install -g @getdomovoi/osnova

osnova build .                      # index the repository (cached, incremental after this)
osnova ground "where do we validate tokens"
osnova warp src/auth.ts#verify      # who calls it
osnova groundwork                   # directory clusters, hubs, hotspots
```

## Install once, use everywhere

One global install serves every repository and every agent. `osnova mcp` with no `--workspace` uses the directory the client starts it in, and MCP clients start servers in the project root. So each client needs one entry, in its own global config, and nothing per project. Osnova never writes inside your repository and never touches another client's configuration.

Claude Code:

```sh
claude mcp add --scope user osnova -- osnova mcp
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.osnova]
command = "osnova"
args = ["mcp"]
```

OpenCode, in `~/.config/opencode/opencode.json`:

```json
{ "mcp": { "osnova": { "type": "local", "command": ["osnova", "mcp"], "enabled": true } } }
```

Pi, through the `pi-mcp-adapter` extension, in `~/.pi/agent/mcp.json`:

```json
{ "mcpServers": { "osnova": { "command": "osnova", "args": ["mcp"] } } }
```

Kilo, in `~/.config/kilo/kilo.jsonc`:

```json
{ "mcp": { "osnova": { "type": "local", "command": ["osnova", "mcp"], "enabled": true } } }
```

Cursor, in `~/.cursor/mcp.json`, and any other client that takes the common `mcpServers` shape:

```json
{ "mcpServers": { "osnova": { "command": "osnova", "args": ["mcp"] } } }
```

No global install? Replace `osnova` with `npx -y @getdomovoi/osnova` in any of the above. Pin a workspace with `osnova mcp --workspace /path/to/repo` when the client does not start in the project root.

Not sure what your config looks like after the change? Ask for a diff:

```sh
osnova setup --preview --client codex
```

It reads the client's real config file, proposes the one entry as a unified diff, and stops. Nothing is written. Other entries, comments and formatting stay as they are. If an `osnova` entry already exists it says so instead of proposing anything. Clients: `claude-code`, `codex`, `opencode`, `kilo`, `cursor`, `pi`. Add `--command npx --command -y --command @getdomovoi/osnova` for the no-install form.

`osnova doctor` checks the runtime, the cache and every packaged grammar.

## The seven tools

The tool names play on the foundation image. The CLI uses the same seven names without the prefix, so `osnova ground` on the command line and `osnova_ground` over MCP are the same query.

| Tool | Meaning | Does |
| --- | --- | --- |
| `osnova_ground` | the ground you stand on | Keyword search: ranked definitions with exact `file:line` and an excerpt |
| `osnova_thread` | the thread you follow through the cloth | Text search: regex or literal matches grouped by enclosing symbol |
| `osnova_outline` | the outline of one part | Signatures and line spans for one file |
| `osnova_warp` | the warp threads that hold the weave | Call graph: callers and callees, direct or transitive |
| `osnova_groundwork` | the groundwork under everything | Repository map: directory clusters, hubs and hotspots |
| `osnova_footing` | the footing you build on | Task context: the definitions, relationships and candidate tests around a question or named symbols |
| `osnova_settle` | how the ground settles after a change | Change impact: the symbols a unified diff touches and their indexed dependents |
| `osnova_plumb` | the plumb line that tests true vertical | Check claims: which of a listed set of call sites the index confirms, which are name matches only, and which dependents were left out |

Every response opens with `osnova generation <id>`. When the index is partial, one `osnova foundation:` line counts the diagnostics by phase and code. Outputs stay under fixed budgets (16,384 code units for search, 8,192 for task context, 4,096 for outlines and change impact, 2,048 for call graphs and maps) and always print exact omission counts, so the agent knows when to ask for more.

A typical agent turn with Osnova:

1. `osnova_footing` with `task: "change"` and the question. The agent gets the seed definitions, who calls them, and which tests touch them.
2. Edit.
3. `git diff` into `osnova_settle`. The agent gets every indexed dependent of the changed spans and checks them before it finishes.

## How much of the graph is exact

A call site counts as resolved when the index ties it to one definition through evidence it can name: an import binding, a lexical definition in the same file, a re-export chain it followed, or a receiver it could identify (`this`, a constructor site, a class reference, or an annotated parameter). Everything else stays unresolved with a reason, and every answer from Osnova says so. These are the shares on the pinned benchmark checkouts, measured by `scripts/coverage-corpora.mjs` and recorded in [`benchmarks/results/resolution-coverage-2026-09-17.json`](benchmarks/results/resolution-coverage-2026-09-17.json):

| Corpus | Language | Call sites | Resolved | Share | Excluding unresolved imports |
|---|---|---:|---:|---:|---:|
| click | python | 5018 | 687 | 13.7% | 21.9% |
| click | all | 5018 | 687 | 13.7% | 21.9% |
| pyright | python | 11608 | 3172 | 27.3% | 33.6% |
| pyright | typescript | 46733 | 18488 | 39.6% | 43.1% |
| pyright | all | 58373 | 21660 | 37.1% | 41.3% |
| zod | tsx | 150 | 7 | 4.7% | 6.7% |
| zod | typescript | 53067 | 5871 | 11.1% | 18.8% |
| zod | all | 53246 | 5888 | 11.1% | 18.8% |

A call through an import the index cannot resolve, which is mostly a package outside the repository, can never resolve locally, so the last column leaves those call sites out of the denominator. The unresolved remainder is mostly method calls on objects the syntax does not identify. `osnova coverage` reports these numbers for your own repository, per language and per reason, and `osnova_plumb` checks any list of call sites against the index so a claimed caller list can be verified before it is trusted.

## CLI

```sh
osnova build <root>            # build and cache the index
osnova ground "<question>"     # keyword search with exact file:line hits (--scoped ranks per package)
osnova thread "<pattern>"      # regex or literal search grouped by symbol
osnova outline <file>          # every definition's signature and span
osnova warp <symbol>           # direct or transitive callers or callees
osnova groundwork              # directory clusters, hubs, hotspots
osnova footing "<question>"    # task context as JSON
osnova settle --base-cache ... # compare two preserved indexes
osnova plumb <symbol> --site <path:line> ...  # check claimed call sites against the index
osnova coverage [--json]       # call-site resolution coverage per language and reason
osnova check <root>            # staleness gate for CI (exit 1 when stale)
osnova doctor                  # read-only runtime and asset checks
osnova setup --preview --client <name>  # diff for one client's config; never applies
osnova mcp [--workspace <path>] # MCP stdio server (default: current directory)
```

## Library

```ts
import { buildIndex, ask, callersDetailed, renderMapCard } from "@getdomovoi/osnova";

const index = await buildIndex("/path/to/repo");
const hits = ask(index, "where do we validate tokens", { limit: 5 });
const callers = callersDetailed(index, "src/auth.ts#verify", { direction: "in", depth: 2 });
const card = await renderMapCard(index);
```

The structured APIs return complete results with omission counts. The text budgets above apply to CLI and MCP presentation only. See the [reference](docs/reference.md) for every export, the ranking rules, caller evidence, index health, cache layout and the benchmark harness.

## What Osnova does not do

- No type inference and no dynamic dispatch. Edges come from syntax: direct calls, imports, exports and name references, with lexical binding and receiver hints for TypeScript, JavaScript and Python. Resolution is heuristic and says so.
- No semantic search. `osnova_ground` is fielded lexical ranking over definitions. It is fast, deterministic and explainable, and it will not match a paraphrase.
- No proof of safety. An empty caller list means the index found no caller, not that none exists.
- No cost claims. Agent trials so far show correctness parity with and without the graph on small tasks. A benchmark that separates the two is in progress.

## How it stays honest

- Every query refreshes the index from the working tree first and reports its generation.
- Every clipped output says how much was clipped. Every ranked list says how many candidates it dropped.
- Every benchmark result in [`benchmarks/results/`](benchmarks/results/) is frozen with its corpus fingerprint, and rejected experiments stay on record next to accepted ones.
- The cache verifies a SHA-256 over the structural core before parsing it and hash-checks each source text on read.

## Contributing

Bug reports, language adapters, benchmark corpora and agent trials are all welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the gates a change must pass: lint, typecheck, tests, build, perf budgets and package smoke.

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm perf
```

Determinism is the core invariant. A change that makes incremental refresh differ from a full rebuild by one byte is a bug.

## License

Apache-2.0
