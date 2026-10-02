# osnova for Claude Code

Osnova indexes your repository with tree-sitter into a symbol and call graph and serves it to Claude Code. Ask who calls a function and get its indexed callers with exact file and line, plus the evidence behind each edge. A call it cannot resolve from the written source, such as a dynamic dispatch, is reported as unresolved with its same-name candidates instead of guessed. Same input, same output, byte for byte. Twenty languages, no embeddings and no telemetry.

Website: [getosnova.dev](https://getosnova.dev). Source, documentation and benchmarks: [getdomovoi/osnova](https://github.com/getdomovoi/osnova).

This plugin is maintained in `integrations/claude-code` of [getdomovoi/osnova](https://github.com/getdomovoi/osnova) and copied to [getdomovoi/osnova-claude-plugin](https://github.com/getdomovoi/osnova-claude-plugin) on every change, so open [issues](https://github.com/getdomovoi/osnova/issues) and pull requests in getdomovoi/osnova.

## What the plugin adds

- **MCP server** `osnova`: ten tools (`osnova_footing`, `osnova_ground`, `osnova_thread`, `osnova_outline`, `osnova_warp`, `osnova_groundwork`, `osnova_settle`, `osnova_plumb`, `osnova_tests`, `osnova_unreferenced`) for symbol search, callers and callees, diff impact, claim checks, test discovery and unreferenced-code candidates.
- **SessionStart hook**: prints one line with the index size and a pointer to the tools. On a repository without an index it starts the build in the background and waits up to three seconds.
- **UserPromptSubmit hook**: when the prompt names code, such as a backticked identifier, it prints up to eight starting definitions with exact file and line.
- **Stop hook**: diffs the worktree against `HEAD` and lists the indexed dependents of the changed symbols, so dependents outside the change are not missed. It continues the turn at most once per diff.
- **Skill** `osnova`: a short order of work (footing, warp, plumb, settle) that Claude Code loads only when a task matches it.

## What it runs, fetches and writes

Every command runs `npx -y @getdomovoi/osnova@0.12.0`, pinned to the release this plugin version ships with. The first run fetches that package from the npm registry; that is npm's request, made once per version, and later runs use the npm cache.

Osnova itself makes no network connection. It reads the repository and writes only to its cache directory: the index and per-session hook state under your user cache directory, or `OSNOVA_CACHE_DIR` when set. It writes nothing inside your repository. The privacy statement is at [getosnova.dev/privacy](https://getosnova.dev/privacy/).

## Requirements

Node.js 22.13 or newer. Licensed under Apache-2.0.
