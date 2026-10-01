# Privacy

Osnova runs on your machine and keeps nothing about you.

## What it reads

Osnova reads the source files of the repository you point it at, applying the repository's `.gitignore` and an optional `.osnovaignore`. It reads the hook payloads a client hands it on stdin (the prompt text, the session id, the working directory) to produce its one-line answers. It reads nothing else.

## What it writes

One cache directory per repository: the structural index, the source-text sidecar and hook state (a small per-session file keyed by the client's session id). The default location is under your user cache directory; `OSNOVA_CACHE_DIR` or `--cache-dir` moves it. Osnova writes nothing inside your repository and nothing outside the cache directory. `osnova setup --apply` is the one exception: it edits the client configuration files you name, backs each one up first, and shows the diff with `--preview` before touching anything. `osnova setup claude --uninstall` and `osnova setup agents --uninstall` reverse it the same way: they preview first, remove only osnova's own entries, delete only the plugin, extension and skill files osnova installed while they are unchanged, and back up each file first.

## What it sends

Nothing. Indexing and every query run offline. Osnova collects no usage data, no telemetry, no crash reports, and phones home to no server. The one command that opens a network connection is `osnova update-check`, which you run yourself; it asks the npm registry for the latest version number and sends nothing but that request.

The Claude Code plugin runs its commands as `npx -y @getdomovoi/osnova@<version>`, pinned to the release the plugin ships with, so the first use of each version fetches the package from the npm registry; that is npm's request, not Osnova's.

Optional LSP enrichment, when you enable it, runs a language server executable that you supply and approve on each use. What that server does with your code is governed by its own policy; Osnova never launches one from its own stored configuration. The one other way to run a language server is to name it on the command line that starts the MCP server (`osnova mcp --lsp-server <path>`); an MCP client that keeps that command in its configuration starts the server with every session, and removing the flag stops it.

## What third parties get

No one. The installed tool has no account, no sign-in, no key and no service behind it; your code and your queries stay on your machine. Two maintainer scripts in the repository, `scripts/resolution-diff.mjs` and `scripts/resolution-levers.mjs`, can send changed-edge samples with their source lines to a review model when `TYPESAFE_API_KEY` is set; they are not in the published package, they stop before sending anything when the key is absent, and the reference describes them.

## Contact

Open an issue at https://github.com/getdomovoi/osnova/issues.
