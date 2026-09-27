<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/getdomovoi/osnova/main/assets/brand/banner-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/getdomovoi/osnova/main/assets/brand/banner-light.png">
  <img src="https://raw.githubusercontent.com/getdomovoi/osnova/main/assets/brand/banner-dark.png" width="1200" alt="osnova. A deterministic code map for AI coding agents. Ten tools over MCP and CLI.">
</picture>

# Osnova

[![npm version](https://img.shields.io/npm/v/%40getdomovoi%2Fosnova)](https://www.npmjs.com/package/@getdomovoi/osnova) [![license Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE) [![ci](https://img.shields.io/github/actions/workflow/status/getdomovoi/osnova/ci.yml?branch=main&label=ci)](https://github.com/getdomovoi/osnova/actions/workflows/ci.yml) [![node >=22.13](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen)](package.json) [![M8ven Verified](https://m8ven.ai/badge/mcp/getdomovoi-osnova-2032ih?variant=verified)](https://m8ven.ai/mcp/getdomovoi-osnova-2032ih)

**A deterministic code map for AI coding agents.** Osnova indexes a repository into a symbol and call graph with tree-sitter, then serves it to any MCP client or from the command line. Same input, same output, byte for byte. No embeddings, no telemetry, and no network connection unless you type `osnova update-check`. Twenty languages, seven of them (TypeScript, JavaScript, Python, Go, Rust, Java, C#) with deep adapters.

*Osnova* is the Slavic word for base or foundation. That is the job: give an agent solid ground to stand on before it edits code.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/getdomovoi/osnova/main/assets/brand/diagram-architecture-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/getdomovoi/osnova/main/assets/brand/diagram-architecture-light.svg">
  <img src="https://raw.githubusercontent.com/getdomovoi/osnova/main/assets/brand/diagram-architecture-dark.svg" width="1600" alt="A coding agent asks osnova a question and gets back exact file and line, the resolution basis and an omission count; osnova reads a local cache that is built and refreshed from the repository by tree-sitter parsing.">
</picture>

## Quick start

Node.js 22.13 or newer. Serve a repository to any MCP client:

```sh
npx -y @getdomovoi/osnova mcp --workspace /path/to/repo
```

Claude Code, one command after `npm install -g @getdomovoi/osnova`: the MCP entry and the session, prompt and stop hooks, with a backup of each file it changes.

```sh
osnova setup --apply --client claude-code --hooks
```

Or add the MCP entry by hand; replace `osnova` with `npx -y @getdomovoi/osnova` when there is no global install.

```json
{ "mcpServers": { "osnova": { "command": "osnova", "args": ["mcp"] } } }
```

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/getdomovoi/osnova/main/assets/brand/diagram-agent-turn-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/getdomovoi/osnova/main/assets/brand/diagram-agent-turn-light.svg">
  <img src="https://raw.githubusercontent.com/getdomovoi/osnova/main/assets/brand/diagram-agent-turn-dark.svg" width="1600" alt="One agent turn in five steps: prompt, footing, edit, settle, review; footing and settle are answered by osnova from the index, the rest are the agent or the developer acting.">
</picture>

## What you get back

<img src="https://raw.githubusercontent.com/getdomovoi/osnova/main/assets/demo/warp.gif" width="1600" alt="A terminal recording: osnova warp lists the five resolved callers of click Context.invoke, each with its receiver hint; grep finds twelve .invoke( lines; osnova plumb checks those twelve and reports five confirmed, six name-only matches on other invoke methods and one line inside a docstring.">

`osnova warp src/api.ts#refreshWorkspace` on this repository, cut to twelve lines (`test/docs-readme-warp.test.ts` fails when the first two no longer reproduce):

```text
function src/api.ts#refreshWorkspace: 83 indexed edges
reach: d1 callers 83 in 14 files (3 dirs); d2 +16 in 2 files; unresolved same-name 9; tests 18
d1 calls src/cli/cli.ts#ensureIndex:78 [import-binding]
d1 calls src/cli/hook.ts#runHook:189,201,223,238 [import-binding]
d1 calls src/mcp/server.ts#createOsnovaMcpServer.refresh:257 [import-binding]
d1 calls test/verification-fastpath.test.ts#<module>:37,47,48,51,53,57,58,64,68,74,78,85,110,114,132,145,154,166,171,197 [re-export-binding]
  via src/index.ts:65 refreshWorkspace -> src/api.ts (export refreshWorkspace)
This does not prove absence of callers or that deletion is safe.
unresolved evidence (9); not confirmed relationships
candidates for refreshWorkspace (2, unverified): src/api.ts#refreshWorkspace, test/mcp-watch.test.ts#refreshWorkspace
d1 calls refreshWorkspace test/artifact-format9.test.ts:78,85,104,120,140 [binding-blocked]
d1 calls refreshWorkspace scripts/perf.mjs:482,483,488 [import-target-unresolved]
```

Each confirmed line names the caller, its lines and the evidence that tied the call to this definition: an import binding, a same-file definition, a re-export chain with its hop, or an identified receiver. Calls the index could not tie to a definition are listed apart as unresolved evidence, with the same-name candidates it found and the reason it stopped, so a name match is never mistaken for a caller. The `reach` line gives exact counts, not scores, and when the list outgrows its budget a `capped:` line and an `omitted:` footer count what was left out.

## How much of the graph is exact

A call site counts as resolved when the index ties it to one definition through evidence it can name; everything else stays unresolved with a reason. These are the shares on the pinned checkouts under `benchmarks/corpora/`, recorded in [`benchmarks/results/resolution-coverage-2026-09-21b.json`](benchmarks/results/resolution-coverage-2026-09-21b.json); the last column leaves out calls through packages outside the repository and calls to builtins, which can never resolve locally, and the [reference](docs/reference.md#resolution-coverage-and-claim-checking) defines every column.

| Corpus | Languages | Call sites | Resolved | Share | Excluding externals |
|---|---|---:|---:|---:|---:|
| click | all | 6593 | 2903 | 44.0% | 62.4% |
| cobra | all | 4374 | 1980 | 45.3% | 88.9% |
| gson | all | 23382 | 8473 | 36.2% | 56.7% |
| humanizer | all | 30517 | 7798 | 25.6% | 51.3% |
| pyright | all | 58578 | 30070 | 51.3% | 74.5% |
| ripgrep | all | 13387 | 6121 | 45.7% | 71.6% |
| zod | all | 53417 | 21630 | 40.5% | 73.2% |

Per-language rows are in the [reference](docs/reference.md#resolution-coverage-and-claim-checking). `osnova coverage` reports the same numbers for your own repository, per language and per reason.

Resolved is not the same as right, so the call edges are also scored against a type checker. Every call site in two pinned checkouts was sent to the language's own checker for the callee's declarations, and each osnova edge was marked true when the symbol it names contains that declaration and false when it does not. Measured at 0.8.0: on click (160 files, pyright 1.1.414) 2883 edges were decided and 0 are false, and osnova covers 90.4% of the call sites the checker resolves inside the repository. On zod (702 files, TypeScript 5.9.3) 21276 edges were decided and 4 are false, a false-edge rate of 0.02%, with 76.9% of in-repo sites covered. The four false edges are listed by site in [`benchmarks/results/type-checker-oracle-2026-09-21.json`](benchmarks/results/type-checker-oracle-2026-09-21.json) with the method and its limits.

## Grep versus the graph

The reason to keep a call graph instead of running a text search is not speed. It is that the first regex a person types is wrong more often than it looks, and nobody notices. Nine call-site sets in five languages were verified line by line; each cell shows sites found (precision / recall), and the [method](docs/reference.md#grep-versus-the-graph-method) lists what each side got wrong.

| Corpus | Target | Verified sites | Text search | Resolved graph |
|---|---|---:|---:|---:|
| click | `Context.invoke` depth 2 | 13 | 12 (0.92 / 0.85) | 12 (1.00 / 0.92) |
| pyright | `getChildNodes` depth 2 | 28 | 5 (0.80 / 0.14) | 28 (1.00 / 1.00) |
| cobra | `Command.Root` depth 1 | 30 | 30 (1.00 / 1.00) | 30 (1.00 / 1.00) |
| cobra | `Command.PersistentFlags` depth 1 | 12 | 13 (0.92 / 1.00) | 12 (1.00 / 1.00) |
| humanizer | `Configurator.GetFormatter` depth 1 | 18 | 19 (0.74 / 0.78) | 18 (1.00 / 1.00) |
| ripgrep | `Searcher.line_terminator` depth 1 | 12 | 32 (0.38 / 1.00) | 12 (1.00 / 1.00) |
| ripgrep | `LineTerminator.as_byte` depth 1 | 26 | 26 (1.00 / 1.00) | 26 (1.00 / 1.00) |
| gson | `JsonReader.beginObject` depth 1 | 10 | 29 (0.34 / 1.00) | 10 (1.00 / 1.00) |
| gson | `TypeToken.getRawType` depth 1 | 27 | 43 (0.63 / 1.00) | 27 (1.00 / 1.00) |

The graph never returned a site that was not a call of the target. The record is [`benchmarks/results/grep-vs-graph-2026-09-21.json`](benchmarks/results/grep-vs-graph-2026-09-21.json).

## The ten tools

The names play on the foundation image. The CLI uses the same names without the prefix: `osnova ground` and `osnova_ground` are the same query.

| Tool | Meaning | Does |
| --- | --- | --- |
| `osnova_ground` | the ground you stand on | Keyword search: ranked definitions with exact `file:line` |
| `osnova_thread` | the thread you follow through the cloth | Text search: regex or literal matches grouped by symbol |
| `osnova_outline` | the outline of one part | Signatures and line spans for one file |
| `osnova_warp` | the threads that hold the weave | Call graph: callers and callees, direct or transitive |
| `osnova_groundwork` | the groundwork under everything | Repository map: directory clusters, hubs and hotspots |
| `osnova_footing` | the footing you build on | Task context: definitions, relationships and candidate tests around a question |
| `osnova_settle` | how the ground settles after a change | Change impact: the symbols a diff touches and their indexed dependents |
| `osnova_plumb` | the plumb line dropped straight through | Check claims: which listed call sites the index confirms, and which dependents were left out |
| `osnova_tests` | the cloth pulled to see what holds | Tests: the test files that reference a symbol, or the symbols one test file reaches |
| `osnova_unreferenced` | threads left loose at the edge | Definitions with no indexed caller, each with its leads; candidates, never proof |

Every MCP response opens with its index generation, says when the index is partial, and counts what its budget left out; the budgets, and which CLI subcommands carry the generation, are in the [reference](docs/reference.md#presentation-budget).

## Hooks and clients

One global install serves every repository and every client: one entry in each client's global config, nothing per project, nothing written inside your repository. `osnova setup --preview --client <name>` shows the diff and writes nothing. What each hook prints, when it stays quiet, and what the trials measured are in the [reference](docs/reference.md#hooks-and-setup-in-full).

| Client | How to wire | What it adds |
| --- | --- | --- |
| Claude Code | `osnova setup --apply --client claude-code --hooks` | MCP entry plus session, prompt and stop hooks; `--skill` adds the skill, `--nudge` the opt-in grep nudge |
| Claude Code, as a plugin | `/plugin marketplace add getdomovoi/osnova` then `/plugin install osnova@osnova` | The same MCP entry, hooks and skill, run through `npx -y @getdomovoi/osnova`, with no global install; updates follow the marketplace |
| Codex | `osnova setup --apply --client codex --hooks` | MCP entry plus the same three hooks; trust them in `/hooks` or Codex skips them silently |
| Cursor | `osnova setup --apply --client cursor --hooks` | MCP entry plus the stop hook as a follow-up message |
| OpenCode | `osnova setup --apply --client opencode --plugin` | MCP entry plus a plugin: full contract in the system prompt, starting points on each message |
| Kilo | `osnova setup --apply --client kilo --plugin` | MCP entry plus the same plugin |
| Pi | `osnova setup --apply --client pi --plugin` | MCP entry through `pi-mcp-adapter` plus an extension that does the same |

## In CI

The action runs `osnova settle --base-ref` against the pull request base and lists every indexed dependent of the symbols the pull request changed; the report is indexed structural evidence only, so a missing dependent is not proof that nothing depends on the change.

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- uses: getdomovoi/osnova@v0.8.1
  with:
    depth: "2"
```

Inputs and the local form are in the [reference](docs/reference.md#settle-in-ci).

## What osnova does not do

- No type inference and no dynamic dispatch. Edges come from syntax: direct calls, imports, name references, declared heritage (a written superclass or interface name) and framework routes (a registration whose receiver binds to a listed framework import, with the verb and the literal path written at the site), with lexical binding and receiver hints for TypeScript, JavaScript and Python. Resolution is heuristic and says so.
- No route table. A `routes` edge is one registration site tied to one handler; prefixes from mounts, blueprints and controllers are recorded on their own edges and never composed into a full path, a computed path records no path, and an inline closure or a wrapped handler records the route with no target. Express, NestJS, Flask and FastAPI are read; gin, axum, Django, Spring, ASP.NET, Rails and file-based routers are not.
- That boundary has a measured price. Scored against a type checker on two pinned corpora, the calls osnova does not resolve are mostly calls whose receiver type is never written down: 2945 of 6359 missed sites on zod and 164 of 307 on click are a plain name carrying no annotation, and another 1478 on zod are a call result or a property chain. Only 349 missed sites on zod and 10 on click have a type written at the receiver's declaration, and 248 of those 349 are a single library idiom. Resolving every one of them would move recall from 76.9% to 78.2% on zod and from 90.4% to 90.7% on click, so the boundary costs roughly one recall point rather than ten. The full census is in [`benchmarks/results/receiver-boundary-census-2026-09-21.json`](benchmarks/results/receiver-boundary-census-2026-09-21.json).
- No semantic search. `osnova_ground` is fielded lexical ranking over definitions. It is fast, deterministic and explainable, and it will not match a paraphrase.
- No proof of safety. An empty caller list means the index found no caller, not that none exists.
- No cost claims. Agent trials so far show correctness parity with and without the graph on small tasks. A benchmark that separates the two is in progress.

## How it stays honest

- Every query refreshes the index from the working tree first, uncommitted edits included, and reports its generation.
- Every clipped output says how much was clipped. Every ranked list says how many candidates it dropped. Partial indexes say so on every response.
- Every hit carries a `file:line` span, a source hash and an index generation, so you can check what the agent cites.
- Every benchmark result in [`benchmarks/results/`](benchmarks/results/) is frozen with its corpus fingerprint, and rejected experiments stay on record next to accepted ones.
- The cache verifies a SHA-256 over the structural core before parsing it and hash-checks each source text on read. Nothing is written outside it.

## CLI

Every tool is a subcommand: `osnova build <root>`, `osnova warp <symbol>`, `osnova settle --base-ref <ref>`, plus `coverage`, `check`, `doctor`, `setup` and `mcp`. The full list is in the [reference](docs/reference.md#cli).

## Library

`import { buildIndex, ask, callersDetailed, renderMapCard } from "@getdomovoi/osnova"`. The structured APIs return complete results with omission counts; the text budgets apply to CLI and MCP presentation only. Every export is in the [reference](docs/reference.md#api).

## Contributing

Bug reports, language adapters, benchmark corpora and agent trials are all welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the gates a change must pass: lint, typecheck, tests, build, perf budgets and package smoke.

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm perf
```

Determinism is the core invariant. A change that makes incremental refresh differ from a full rebuild by one byte is a bug.

## License

Apache-2.0

Privacy: [PRIVACY.md](PRIVACY.md). Security policy and reporting: [SECURITY.md](SECURITY.md).
