# Security policy

## Supported versions

Only the latest published version of `@getdomovoi/osnova` receives fixes.

## What Osnova does

Osnova reads the files in a workspace, writes an index to one cache directory, and answers queries over stdio or the command line. It performs no network access and sends no telemetry. It never writes inside the workspace. Optional language-server enrichment launches only executables the user names explicitly.

## Reporting a vulnerability

Report privately through GitHub: https://github.com/getdomovoi/osnova/security/advisories/new

Include the version, the platform, a minimal workspace or steps that reproduce the issue, and what you observed. You will get an acknowledgement within seven days. Please do not open a public issue for a security report until a fix is published.

Reports that matter most: writes outside the cache directory, reads outside the workspace, command execution from indexed content, and denial of service from crafted source files.
