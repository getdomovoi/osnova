# Security policy

## Supported versions

Only the latest published version of `@getdomovoi/osnova` receives fixes.

## What Osnova does

Osnova reads the files in a workspace, writes an index to one cache directory, and answers queries over stdio or the command line. It sends no telemetry, and the only command that opens a network connection is `osnova update-check`, which asks the npm registry for the latest version number and runs only when you type it. It never writes inside the workspace; the one write outside the cache directory is `osnova setup --apply`, which edits the client configuration files you name under your home directory and backs each one up first. Optional language-server enrichment launches only executables the user names explicitly. [PRIVACY.md](PRIVACY.md) states the same two exceptions from the user's side.

## Reporting a vulnerability

Report privately through GitHub: https://github.com/getdomovoi/osnova/security/advisories/new

Include the version, the platform, a minimal workspace or steps that reproduce the issue, and what you observed. You will get an acknowledgement within seven days. Please do not open a public issue for a security report until a fix is published.

Reports that matter most: writes outside the cache directory, reads outside the workspace, command execution from indexed content, and denial of service from crafted source files.
