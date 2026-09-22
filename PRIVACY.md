# Privacy

Osnova runs on your machine and keeps nothing about you.

## What it reads

Osnova reads the source files of the repository you point it at, applying the repository's `.gitignore` and an optional `.osnovaignore`. It reads the hook payloads a client hands it on stdin (the prompt text, the session id, the working directory) to produce its one-line answers. It reads nothing else.

## What it writes

One cache directory per repository: the structural index, the source-text sidecar and hook state (a small per-session file keyed by the client's session id). The default location is under your user cache directory; `OSNOVA_CACHE_DIR` or `--cache-dir` moves it. Osnova writes nothing inside your repository and nothing outside the cache directory. `osnova setup --apply` is the one exception: it edits the client configuration files you name, backs each one up first, and shows the diff with `--preview` before touching anything.

## What it sends

Nothing. Indexing and every query run offline. Osnova collects no usage data, no telemetry, no crash reports, and phones home to no server. The one command that opens a network connection is `osnova update-check`, which you run yourself; it asks the npm registry for the latest version number and sends nothing but that request.

The Claude Code plugin runs its commands as `npx -y @getdomovoi/osnova`, so the first use fetches the package from the npm registry; that is npm's request, not Osnova's, and it happens once per machine.

Optional LSP enrichment, when you enable it, runs a language server executable that you supply and approve on each use. What that server does with your code is governed by its own policy; Osnova never launches one from stored configuration.

## What third parties get

No one. There is no account, no sign-in, no key, and no service behind the tool. Your code and your queries stay on your machine.

## Contact

Open an issue at https://github.com/getdomovoi/osnova/issues.
