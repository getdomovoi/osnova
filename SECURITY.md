# Security policy

## Supported versions

Only the latest published version of `@getdomovoi/osnova` receives fixes.

## What Osnova does

Osnova reads the files in a workspace, writes an index to one cache directory, and answers queries over stdio or the command line. It sends no telemetry, and the only command that opens a network connection is `osnova update-check`, which asks the npm registry for the latest version number and runs only when you type it. It never writes inside the workspace; the one write outside the cache directory is `osnova setup --apply`, which edits the client configuration files you name under your home directory and backs each one up first. Optional language-server enrichment launches only executables the user names explicitly. [PRIVACY.md](PRIVACY.md) states the same two exceptions from the user's side.

## Exploration hooks

Installed client hooks deny recognized indexed-code exploration before execution. Focused fallback requires a successful Osnova result from the current index; permissions are scoped to a session, agent, prompt and unchanged file. Opaque shell and script launchers require a current successful query, and a denied source target remains blocked until its own file grant is current. The hook does not inspect script contents or child processes. An allowed script can generate commands dynamically, and a host permission classifier can deny a call after Osnova has returned no decision. Preventing those routes requires client permission rules or an operating-system sandbox that covers child processes; Osnova cannot inherit or enforce a denial it never observes. Disabled hooks, unrecognized tool names and host-specific timeout behavior are further limits. An index-verification failure denies recognized exploration; plugin process failures also deny tool execution. Recover by repairing the local executable/cache or explicitly removing the hook configuration.

## Reporting a vulnerability

Report privately through GitHub: https://github.com/getdomovoi/osnova/security/advisories/new

Include the version, the platform, a minimal workspace or steps that reproduce the issue, and what you observed. You will get an acknowledgement within seven days. Please do not open a public issue for a security report until a fix is published.

Reports that matter most: writes outside the cache directory, reads outside the workspace, command execution from indexed content, and denial of service from crafted source files.
