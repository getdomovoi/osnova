<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/getdomovoi/osnova/main/assets/brand/banner-dark.png">
  <img alt="osnova. A deterministic code map for AI coding agents. Eight tools: ground, thread, outline, warp, groundwork, footing, settle, plumb." src="https://raw.githubusercontent.com/getdomovoi/osnova/main/assets/brand/banner-light.png" width="1200">
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

## The eight tools

The tool names play on the foundation image. The CLI uses the same eight names without the prefix, so `osnova ground` on the command line and `osnova_ground` over MCP are the same query.

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

Every successful response opens with `osnova generation <id>`; errors open with `osnova error:` instead. When the index is partial, one `osnova foundation:` line counts the diagnostics by phase and code (the map card carries its own health line). Outputs stay under fixed budgets (16,384 code units for search, 4,096 for task context, outlines, change impact and claim checks, 2,048 for call graphs and maps). Structured selections print exact omission counts; when text still exceeds the budget, a clipping notice states the omitted code units, so the agent knows when to ask for more.

A typical agent turn with Osnova:

1. `osnova_footing` with `task: "change"` and the question. The agent gets the seed definitions, who calls them, and which tests touch them.
2. Edit.
3. `git diff` into `osnova_settle`. The agent gets the indexed dependents of the changed spans to the requested depth (one hop by default, with the frontier beyond it counted) and checks them before it finishes.

## How much of the graph is exact

A call site counts as resolved when the index ties it to one definition through evidence it can name: an import binding (relative paths, and bare specifiers that name a workspace package through its `package.json` name and `exports`, or a Python package under a manifest directory or its `src` layout), a lexical definition in the same file, a re-export chain it followed, or a receiver it could identify (`this`, a constructor site, a class reference, an annotated parameter, field or local, a field assigned once in the constructor, or the declared return type of the function or method that produced the value), and a TypeScript namespace member reached through the namespace name, including members inherited through declared `extends` clauses and Python base classes when every base in the chain is identified and agrees. `implements` clauses are not followed. Everything else stays unresolved with a reason, and every answer from Osnova says so. Go, Rust, Java and C# receivers come from typed parameters, typed locals, constructor literals, declared return types, struct fields, `this`, `self` and the method receiver; Go package imports resolve through `go.mod`, Rust paths through the crate root, Java imports through the package path, and a type declared exactly once in the language family is found without an import. These are the shares on the pinned checkouts (three retrieval corpora plus four coverage-only corpora under `benchmarks/corpora/`), measured by `scripts/coverage-corpora.mjs` and recorded in [`benchmarks/results/resolution-coverage-2026-09-17.json`](benchmarks/results/resolution-coverage-2026-09-17.json):

| Corpus | Language | Call sites | Resolved | Share | Excluding externals |
|---|---|---:|---:|---:|---:|
| click | python | 5018 | 1913 | 38.1% | 53.3% |
| click | all | 5018 | 1913 | 38.1% | 53.3% |
| cobra | go | 4373 | 1843 | 42.1% | 61.7% |
| cobra | all | 4373 | 1843 | 42.1% | 61.7% |
| gson | java | 23340 | 7230 | 31.0% | 34.1% |
| gson | all | 23340 | 7230 | 31.0% | 34.1% |
| humanizer | c_sharp | 28771 | 7597 | 26.4% | 38.5% |
| humanizer | javascript | 922 | 132 | 14.3% | 33.9% |
| humanizer | tsx | 120 | 14 | 11.7% | 15.7% |
| humanizer | typescript | 684 | 4 | 0.6% | 1.2% |
| humanizer | all | 30497 | 7747 | 25.4% | 37.7% |
| pyright | python | 11614 | 3272 | 28.2% | 62.8% |
| pyright | typescript | 46759 | 25414 | 54.4% | 64.6% |
| pyright | all | 58405 | 28686 | 49.1% | 64.3% |
| ripgrep | rust | 13329 | 3569 | 26.8% | 31.2% |
| ripgrep | all | 13343 | 3573 | 26.8% | 31.2% |
| zod | tsx | 150 | 7 | 4.7% | 8.3% |
| zod | typescript | 53208 | 16107 | 30.3% | 49.7% |
| zod | all | 53387 | 16124 | 30.2% | 49.6% |

A call through an import the index cannot resolve, which is mostly a package outside the repository, and a call to a name with no binding in the file, which is a builtin or a global such as `len`, `Error` or `new Map()`, can never resolve locally, so the last column leaves both out of the denominator. That includes calls on values those imports produce, such as `expect(x).toBe(y)` from a test framework. `osnova coverage` prints both shares and the counts behind them. The unresolved remainder is mostly method calls on objects the syntax does not identify. `osnova coverage` reports these numbers for your own repository, per language and per reason, and `osnova_plumb` checks any list of call sites against the index so a claimed caller list can be verified before it is trusted.

## Grep versus the graph

The reason to keep a call graph instead of running a text search is not speed. It is that the first regex a person types is wrong more often than it looks, and nobody notices. Five call-site sets on public checkouts were verified line by line after two independent agent runs and a manual review; the manifest is [`benchmarks/exactness/exactness-v1.json`](benchmarks/exactness/exactness-v1.json) and `scripts/exactness.mjs` reproduces the table from the pinned checkouts. Each cell shows sites found (precision / recall against the verified set).

| Corpus | Target | Verified sites | Text search | Resolved graph |
|---|---|---:|---:|---:|
| click | `Context.invoke` depth 2 | 13 | 12 (0.92 / 0.85) | 12 (1.00 / 0.92) |
| pyright | `getChildNodes` depth 2 | 28 | 5 (0.80 / 0.14) | 28 (1.00 / 1.00) |
| cobra | `Command.Root` depth 1 | 30 | 30 (1.00 / 1.00) | 28 (1.00 / 0.93) |
| cobra | `Command.PersistentFlags` depth 1 | 12 | 13 (0.92 / 1.00) | 12 (1.00 / 1.00) |
| humanizer | `Configurator.GetFormatter` depth 1 | 18 | 19 (0.74 / 0.78) | 18 (1.00 / 1.00) |

What the text search got wrong: a comment that mentioned the method, a Javadoc example, a definition line, and four calls split across lines (`Configurator` on one line, `.GetFormatter(` on the next). What the graph missed: a receiver that is reassigned later in the same function, and a receiver that comes out of a multi-value return, both left unresolved on purpose rather than guessed. The graph never returned a site that was not a call of the target. The record is [`benchmarks/results/grep-vs-graph-2026-09-17.json`](benchmarks/results/grep-vs-graph-2026-09-17.json).

## In CI

The same check runs on every pull request without an agent. The action indexes the base commit and the head at the same path, then lists every indexed dependent of the symbols the pull request changed in the job summary, and as a comment when asked:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- uses: getdomovoi/osnova@main
  with:
    depth: "2"
```

Inputs: `base-ref` (default: the pull request base), `depth`, `workspace`, `version` (the npm version run through `npx`), `command` (run a local build instead), `comment` (post a PR comment; needs `GH_TOKEN` with pull-requests write). The report is indexed structural evidence only: a missing dependent is not proof that nothing depends on the change. `scripts/settle-ci.sh` is the whole action and runs by hand with `BASE_REF=<commit> bash scripts/settle-ci.sh`.

## Checking a claim

A reviewer, an agent or a commit message claims "these are all the callers". `plumb` checks the claim against the index instead of trusting it. Each claimed site is confirmed, name-only, no-call or not-indexed, and the resolved dependents the list left out are named. This is the click repository at the revision pinned in `benchmarks/click-v1.json`, with a claim that has two wrong lines and misses six:

```sh
osnova plumb "src/click/core.py#Context.invoke" --depth 2 \
  --site src/click/core.py:934 --site src/click/core.py:1420 --site src/click/core.py:2000 \
  --site src/click/decorators.py:93 --site src/click/decorators.py:200
```

```text
osnova plumb: src/click/core.py#Context.invoke, 3 confirmed, 0 name-only, 2 no-call, 0 not-indexed, 6 missing
claims:
confirmed src/click/core.py:934 -> src/click/core.py#Context.forward
confirmed src/click/core.py:1420 -> src/click/core.py#Command.invoke
no-call src/click/core.py:2000
confirmed src/click/decorators.py:93 -> src/click/decorators.py#make_pass_decorator.decorator.new_func
no-call src/click/decorators.py:200
missing:
src/click/core.py:1566 src/click/core.py#Command.main
src/click/core.py:2029 src/click/core.py#Group.invoke._process_result
src/click/core.py:2039 src/click/core.py#Group.invoke
src/click/core.py:2060 src/click/core.py#Group.invoke
src/click/core.py:2092 src/click/core.py#Group.invoke
src/click/decorators.py:119 src/click/decorators.py#pass_meta_key.decorator.new_func
```

`confirmed` means the index holds a resolved call edge at that line; it is not a runtime proof. `missing` covers indexed resolved edges only, so a call the index could not resolve, such as `super().invoke(ctx)`, does not appear in either list; `osnova_warp` shows those as unresolved evidence with same-name candidates. Over MCP the same check is `osnova_plumb` with `symbol`, `sites` and `depth`.

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
osnova mcp [--workspace <path>] [--watch] # MCP stdio server; --watch refreshes on file change instead of per query
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
