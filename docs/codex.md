# Osnova with Codex

Codex explores a repository with shell search. Osnova adds a call graph it can query: callers and callees with exact `file:line`, the tests that reach a symbol, and the dependents of an uncommitted diff, each answer saying what it left out. Everything runs locally; nothing is sent anywhere and nothing is written inside your repository.

## Set up

Osnova needs Node.js 22.13 or later. Run Codex once first, so `~/.codex` exists.

```sh
npm install -g @getdomovoi/osnova
osnova setup agents --only codex           # preview: prints each change, writes nothing
osnova setup agents --only codex --apply   # writes the changes, backing up every file it edits
```

This writes three things:

| File | What it adds |
| --- | --- |
| `~/.codex/config.toml` | an `[mcp_servers.osnova]` table that runs `osnova mcp`; every other key is kept |
| `~/.codex/hooks.json` | session, prompt and stop hooks (`osnova hook ... --client codex`); hooks that are not osnova's are kept |
| `~/.agents/skills/osnova/SKILL.md` | a skill Codex loads at start, telling it which tool fits which question |

Then open Codex, run `/hooks`, and trust the three osnova entries. Codex skips new or changed hooks until you trust them, and says nothing when it does.

Without `--only codex`, `osnova setup agents` also sets up any other installed harness that reads `AGENTS.md` (OpenCode, Kilo, Pi, Cursor), sharing the same skill.

## Check it

```sh
codex mcp list    # osnova should be listed as enabled
osnova doctor     # checks the install, the grammars and the cache
```

In a repository, ask Codex something that needs the graph, for example "who calls `parseConfig`, and which tests reach it?". The MCP server starts building the index when Codex launches it; the first question waits for that build, and later questions reuse the index.

## What the hooks do

- **Session start:** one line with the index size and a pointer to the tools. On a repository with no index yet, it starts the build in the background.
- **Each prompt:** up to eight starting points, the definitions your prompt names in code form (a backticked name or an identifier such as `parseConfig`), with exact `file:line`.
- **Stop:** before Codex finishes, the indexed dependents of what it changed. If more than one lies outside the change, the turn continues once so Codex can check them.

The hooks never write to the repository. On a failure they print one error line and nothing else.

## Options

Flags go after `mcp` in the `args` of `[mcp_servers.osnova]`; setup keeps them when it later repoints the entry.

- `--no-prewarm` skips warming the search data after each index build, saving memory on very large repositories (about 200 MB on an 18,000-file one) at the cost of a slower first search. The index itself is still built at launch.
- `--lsp-server <absolute path> --lsp-languages <list>` adds a language server's references to callers answers from `osnova_warp`, to callers claims checked by `osnova_plumb` and to change impact from `osnova_settle`, as a separate section; they never become graph edges. For Python with pyright:

  ```toml
  [mcp_servers.osnova]
  command = "osnova"
  args = ["mcp", "--lsp-server", "/absolute/path/to/pyright-langserver", "--lsp-languages", "python", "--lsp-arg=--stdio"]
  ```

The [reference](reference.md) lists every flag.

## Troubleshooting

- **The hooks never fire:** open `/hooks` and trust the osnova entries.
- **A file or symbol is not found:** the MCP server indexes the Git repository that holds the directory Codex started in (that directory itself outside Git), and its instructions name that checkout. If Codex works in another checkout or worktree, start Codex there.
- **The first answer on a large repository is slow:** the first query waits for the index build to finish; later queries reuse the index.

## Remove it

```sh
osnova setup agents --only codex --uninstall           # preview
osnova setup agents --only codex --uninstall --apply   # removes osnova's entries, backing up each file
```

Only osnova's own entries go; other MCP servers and hooks stay. The shared skill is deleted only if it is still the shipped copy and no other installed harness that reads it (OpenCode, Kilo, Pi) is left out of the removal, as `--only codex` leaves them.
