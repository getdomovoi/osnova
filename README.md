<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/getdomovoi/osnova/main/assets/brand/banner-dark.png">
  <img alt="osnova. A deterministic code map for AI coding agents. Eight tools: ground, thread, outline, warp, groundwork, footing, settle, plumb." src="https://raw.githubusercontent.com/getdomovoi/osnova/main/assets/brand/banner-light.png" width="1200">
</picture>

# Osnova

**A deterministic code map for AI coding agents.** Osnova indexes a repository into a symbol and call graph with tree-sitter, then serves it to any MCP client or from the command line. Same input, same output, byte for byte. No embeddings, no telemetry, and no network connection unless you type `osnova update-check`.

*Osnova* is the Slavic word for base or foundation. That is the job: give an agent solid ground to stand on before it edits code.

```sh
npx -y @getdomovoi/osnova mcp --workspace /path/to/repo
```

## Why Osnova

- **Exact answers.** Every hit carries a `file:line` span, a source hash and an index generation. An agent can cite it and you can check it.
- **Deterministic by design.** Incremental refresh produces the same bytes as a full rebuild. Paths, symbols and edges are sorted before they are written. Runs are reproducible.
- **Honest about limits.** Results state what was omitted and why. Partial indexes say so on every response. Absence of a caller never claims deletion is safe.
- **Local and read-only.** One cache directory, no writes inside your repository, no per-agent files to keep in sync, no usage reporting. Indexing and every query run offline. The one command that opens a network connection is `osnova update-check`, which asks the npm registry for the latest version and runs only when you type it.
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

One command applies all of it for Claude Code: `osnova setup --apply --client claude-code --hooks` writes the MCP entry to `~/.claude.json` and the three hook groups to `~/.claude/settings.json`, backing up each file it changes as `<file>.bak-osnova-<stamp>`, and does nothing on a second run; `--preview` prints the same diffs without writing, and a conflicting entry stops the whole apply. `--instructions AGENTS.md` appends a short block once between `<!-- osnova:start -->` and `<!-- osnova:end -->` markers: a pointer to the tools and the two reading rules, since the MCP server's `instructions` already carry the tool list. `osnova doctor` then checks that every configured hook and MCP command reports this osnova's version, and that each installed plugin or skill file matches the one this osnova ships.

Measured on Claude Code with blast-radius tasks that name their symbol, the hooks did not cut turns or cost against the MCP server alone, which already carries the contract as MCP instructions; they pay on prompts that name no symbol and on editing turns. Claude Code hooks, so the graph speaks first without a tool call: `osnova hook session` prints one line when a session starts, the index size and a pointer to the tools (the MCP `instructions` already carry the contract; `--full-contract` restates it for a harness without MCP), and `osnova hook prompt` prints up to eight starting points (the definitions the prompt names with exact `file:line`, plus one line counting the related definitions and relationships it leaves to `osnova_footing` and `osnova_warp`; no relationship lines, since the callees are in the body the agent reads next, all under 1,024 code units) on every prompt. Both read the hook payload on stdin, never write to the repository, and print nothing on a slash command, a short prompt, or a failure. `osnova hook stop` runs when the agent is about to finish: it diffs the worktree against `HEAD` and hands back the indexed dependents of the changed symbols; it continues the turn at most once per diff per session, and only when more than `OSNOVA_HOOK_SETTLE_BLOCK_AT` dependents (default 1) lie outside the change, through `hookSpecificOutput.additionalContext` on Claude Code, `decision: "block"` on Codex and `followup_message` on Cursor, and otherwise warns the user through `systemMessage` without continuing. On a repository with no cache the session hook starts the build in the background, waits up to three seconds for it, so a small repository has starting points from its first prompt, and otherwise the other hooks stay quiet until the cache exists. The workspace is the git top level of the client's directory. The prompt hook seeds only from names the prompt spells as code, a backticked token or an identifier with an inner capital, underscore or digit, so a prose word that happens to be a symbol name, such as `load` or `within`, prints nothing. `osnova hook tool` is an opt-in `PostToolUse` hook (`osnova setup --apply --hooks --nudge`, or `osnova hook install-preview --nudge`): after a `Grep` call or a Bash `grep` or `rg` whose pattern is one identifier or method name that the index knows with resolved callers, it adds one line with the resolved call-site count, the file count and the `osnova_warp` call that lists them, once per name per session and nothing otherwise. Both the once-per-name and once-per-diff state live under the cache directory as `hook-state/<session id>.json`, never in the repository or the system temporary directory. Measured headless on the same blast-radius tasks, it fired as designed and changed nothing: the model's greps come after its first `osnova_warp` call, as confirmation reads, and a line that arrives after the grep does not remove them (Bash calls 38 against 39, cost 5 percent higher, inside run noise). It is not in the default hook set. `osnova hook install-preview` prints the settings snippet; paste it into `~/.claude/settings.json` yourself, since osnova never edits that file.

Other harnesses get the same three levers by their own means. `osnova setup --apply --client codex --hooks` writes `~/.codex/hooks.json` with the same session, prompt and stop hooks (Codex reads the `hookSpecificOutput` JSON it validates). Codex skips a new or changed hook until you trust it: after the apply, open `/hooks` in Codex and trust the three osnova entries, or they are skipped without a message. `--client cursor --hooks` writes `~/.cursor/hooks.json` with the stop hook as a follow-up message, since Cursor's prompt hook cannot add context. `--client opencode --plugin` and `--client kilo --plugin` copy the shipped plugin into the client's `plugins/` directory: it puts the full contract into the system prompt (`osnova hook session --full-contract`) and appends starting points to each user message by calling `osnova hook`. `--client pi --plugin` copies the shipped extension into `~/.pi/agent/extensions/`, which does the same through `before_agent_start`. Every MCP client also receives the contract as the server's `instructions` on initialize, so a client without hooks or plugins still sees it. `osnova setup --apply --skill` copies the shipped Claude Code skill to `~/.claude/skills/osnova/SKILL.md`: a short order of work (footing, then warp, plumb any claimed list, settle before finishing) that Claude Code loads only when a task matches its description, so it costs nothing on other prompts. The file is never overwritten once present. Measured on the same blast-radius tasks with Claude Code headless: when the prompt names the MCP server the skill is never opened, and when the prompt says nothing about it the skill is opened first in three of four runs, the arm answers four of four perfectly against three of four without it, and costs 14 percent more, most of it the checks the skill asks for. It is a discipline for longer tasks, not a saving.

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

## The nine tools

The tool names play on the foundation image. The CLI uses the same nine names without the prefix, so `osnova ground` on the command line and `osnova_ground` over MCP are the same query.

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
| `osnova_tests` | the load test before the floor is trusted | Tests: the indexed test files that reference a symbol with the basis of each edge, or the symbols one test file reaches |

Every successful response opens with `osnova generation <id>`; errors open with `osnova error:` instead. When the index is partial, one `osnova foundation:` line counts the diagnostics by phase and code (the map card carries its own health line). Outputs stay under fixed budgets (16,384 code units for search, 4,096 for task context, outlines, change impact and claim checks, 2,048 for call graphs and maps). Structured selections print exact omission counts; when text still exceeds the budget, a clipping notice states the omitted code units, so the agent knows when to ask for more.

A typical agent turn with Osnova:

1. `osnova_footing` with `task: "change"` and the question. The agent gets the seed definitions, who calls them, and which tests touch them.
2. Edit.
3. `git diff` into `osnova_settle`. The agent gets the indexed dependents of the changed spans to the requested depth (one hop by default, with the frontier beyond it counted) and checks them before it finishes.

## How much of the graph is exact

A call site counts as resolved when the index ties it to one definition through evidence it can name: an import binding (relative paths, and bare specifiers that name a workspace package through its `package.json` name and `exports`, or a Python package under a manifest directory or its `src` layout), a lexical definition in the same file, a re-export chain it followed, or a receiver it could identify (`this`, a constructor site, a class reference, an annotated parameter, field or local, a field assigned once in the constructor, the declared return type of the function or method that produced the value (or, without an annotation, the constructor it returns on every path), a field of any of those whose declared type the holder records, so `this.pool.conn.send()` follows two field types across files, or the value inside a wrapper: `await f()` on a `Promise<Foo>` return type, and Rust `f()?`, `f().unwrap()` and `f().expect(..)` on `Result<Foo, E>` and `Option<Foo>`; and the element or value of a collection whose annotation names it: `for (const x of xs)`, `xs.forEach((x) => ..)`, `xs[0]`, `map.get(k)`, `map.values()` over `Foo[]`, `Set<Foo>`, `Map<K, Foo>`, `list[Foo]` and `dict[K, Foo]`, including fields and return types in other files, and a local that aliases a member chain), and a TypeScript namespace member reached through the namespace name, including members inherited through declared `extends` clauses and Python base classes when every base in the chain is identified and agrees. `implements` clauses are not followed. Everything else stays unresolved with a reason, and every answer from Osnova says so. Go, Rust, Java and C# receivers come from typed parameters, typed locals, constructor literals, declared return types, struct fields, `this`, `self` and the method receiver; Go package imports resolve through `go.mod`, Rust paths through the crate root, Java imports through the package path, and a type declared exactly once in the language family is found without an import. These are the shares on the pinned checkouts (three retrieval corpora plus four coverage-only corpora under `benchmarks/corpora/`), measured by `scripts/coverage-corpora.mjs` (which also reloads each index from its cache and checks the edge count and resolved count match) and recorded in [`benchmarks/results/resolution-coverage-2026-09-18a.json`](benchmarks/results/resolution-coverage-2026-09-18a.json):

| Corpus | Language | Call sites | Resolved | Share | Excluding externals |
|---|---|---:|---:|---:|---:|
| click | python | 5022 | 1932 | 38.5% | 57.2% |
| click | all | 5022 | 1932 | 38.5% | 57.2% |
| cobra | go | 4374 | 1980 | 45.3% | 88.9% |
| cobra | all | 4374 | 1980 | 45.3% | 88.9% |
| gson | java | 23382 | 8473 | 36.2% | 56.7% |
| gson | all | 23382 | 8473 | 36.2% | 56.7% |
| humanizer | c_sharp | 28786 | 7654 | 26.6% | 52.4% |
| humanizer | javascript | 927 | 132 | 14.2% | 55.5% |
| humanizer | tsx | 120 | 14 | 11.7% | 23.3% |
| humanizer | typescript | 684 | 4 | 0.6% | 1.3% |
| humanizer | all | 30517 | 7804 | 25.6% | 51.3% |
| pyright | python | 11617 | 3326 | 28.6% | 66.7% |
| pyright | typescript | 46812 | 26716 | 57.1% | 74.4% |
| pyright | all | 58461 | 30042 | 51.4% | 73.4% |
| ripgrep | rust | 13371 | 6117 | 45.8% | 71.7% |
| ripgrep | all | 13385 | 6121 | 45.7% | 71.6% |
| zod | javascript | 29 | 10 | 34.5% | 83.3% |
| zod | tsx | 150 | 7 | 4.7% | 10.1% |
| zod | typescript | 53238 | 21166 | 39.8% | 71.4% |
| zod | all | 53417 | 21183 | 39.7% | 71.3% |

A call through an import the index cannot resolve, which is mostly a package outside the repository, and a call to a name with no binding in the file, which is a builtin or a global such as `len`, `Error` or `new Map()`, can never resolve locally, so the last column leaves both out of the denominator. That includes calls on values those imports produce, such as `expect(x).toBe(y)` from a test framework, and calls at the end of a field, element or return chain whose recorded type is a builtin (`string`, `Array`, `Map`, a Rust primitive, `Vec` or `Option`) or a type behind an unresolved import; a chain that ends on a type parameter stays unresolved, not external, unless the parameter is bounded. A call on a literal or on a local assigned from one (`", ".join(..)`, `rv = []`, `` `a${b}`.trim() ``) is a call on `str`, `list`, `string` or `Array`, so it is external too, and in Go, Rust, Java and C#, which bind plain names without an import statement, a name that no indexed file of the language defines (`new IllegalArgumentException(..)`, `len(xs)`) is a builtin or a standard-library name and counts as external rather than as a name with no match. A receiver whose annotation names a language builtin (`string`, `Array`, `str`, `list`) stays external even when the repository defines a function of that name, as zod does with its `string()` factory; a class or interface of that name still wins. `osnova coverage` prints both shares and the counts behind them. The unresolved remainder is mostly method calls on objects the syntax does not identify. `osnova coverage` reports these numbers for your own repository, per language and per reason, and `osnova_plumb` checks any list of call sites against the index so a claimed caller list can be verified before it is trusted.

## Grep versus the graph

The reason to keep a call graph instead of running a text search is not speed. It is that the first regex a person types is wrong more often than it looks, and nobody notices. Nine call-site sets on public checkouts in five languages were verified line by line after two independent agent runs and a manual review; the manifest is [`benchmarks/exactness/exactness-v1.json`](benchmarks/exactness/exactness-v1.json) and `scripts/exactness.mjs` reproduces the table from the pinned checkouts. Each cell shows sites found (precision / recall against the verified set).

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

What the text search got wrong: a comment that mentioned the method, Javadoc examples, a definition line, four calls split across lines (`Configurator` on one line, `.GetFormatter(` on the next), and same-named methods on other types: `line_terminator` on three builders and on the `Matcher` trait, `beginObject` on `JsonWriter`, `getRawType` on `ParameterizedType` and as a static helper on `GsonTypes`. What the graph missed: one receiver that comes out of a multi-value return in click, left unresolved rather than guessed. Reassigned receivers in Go, Rust, Java and C# resolve, since a name's static type cannot change in those languages, as do `self` inside a closure, a name taken out of an `Option` by `if let`, `while let` or a match arm, a type imported from another crate of the same Cargo workspace through its `pub use`, and a call on a bounded type parameter (`M: Matcher`, `T extends Runner`, `[T Runner]`, `where T : IRunner`) or an `impl Trait` parameter, which resolves to the trait or interface method the compiler dispatches through. The graph never returned a site that was not a call of the target. The record is [`benchmarks/results/grep-vs-graph-2026-09-18.json`](benchmarks/results/grep-vs-graph-2026-09-18.json).

## In CI

Locally, `osnova settle --base-ref <ref>` compares the working tree with any commit: it exports the commit's tree with `git archive` into the cache directory (no checkout, no worktree), indexes it there once per commit (the two most recent base trees per workspace are kept), takes `git diff <ref>` as the changed spans and lists every indexed dependent of the changed symbols. Over MCP the same comparison is `osnova_settle` with `baseRef`; without `baseRef` the tool compares against the current index only. It fails closed when `git` is missing, the ref is unknown or the workspace is not a git repository.

The same check runs on every pull request without an agent. The action runs `osnova settle --base-ref` against the pull request base, then lists every indexed dependent of the symbols the pull request changed in the job summary, and as a comment when asked:

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
osnova settle --base-ref <ref> # dependents of the symbols changed since a git commit (--base-cache compares two preserved indexes)
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
