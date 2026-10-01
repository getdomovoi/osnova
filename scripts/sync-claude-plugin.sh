#!/bin/sh
# Mirrors the Claude Code plugin into a checkout of getdomovoi/osnova-claude-plugin, the repository the Claude plugin
# directory reads. The directory blocks this repository because its pnpm-workspace.yaml has an allowBuilds key, so the
# plugin is published from a repository that holds only the plugin. integrations/claude-code stays the source of truth.
# Usage: scripts/sync-claude-plugin.sh <plugin-repository-checkout>
set -eu

refuse() {
  echo "sync-claude-plugin: $1" >&2
  exit 1
}

target=${1:?usage: sync-claude-plugin.sh <plugin-repository-checkout>}
root=$(cd "$(dirname "$0")/.." && pwd -P)
dest=$(cd "$target" 2>/dev/null && pwd -P) || refuse "$target is not a directory"

# The sync replaces everything in the destination, so it runs only on a clean checkout of the plugin repository.
top=$(git -C "$dest" rev-parse --show-toplevel 2>/dev/null) || refuse "$dest is not a git checkout"
[ "$(cd "$top" && pwd -P)" = "$dest" ] || refuse "$dest is not the top of a git checkout"
case "$dest/" in "$root/"*) refuse "$dest is inside this repository" ;; esac
case "$root/" in "$dest/"*) refuse "$dest contains this repository" ;; esac
origin=$(git -C "$dest" remote get-url origin 2>/dev/null) || origin=
printf '%s\n' "$origin" | grep -Eq '^(git@github\.com:|ssh://git@github\.com/|https://github\.com/)getdomovoi/osnova-claude-plugin(\.git)?/?$' ||
  refuse "$dest is not a checkout of getdomovoi/osnova-claude-plugin (origin: ${origin:-none})"
[ -z "$(git -C "$dest" status --porcelain)" ] || refuse "$dest has uncommitted changes"

find "$dest" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R "$root/integrations/claude-code/." "$dest/"
cp "$root/LICENSE" "$root/NOTICE" "$dest/"
