#!/bin/sh
# Mirrors the Claude Code plugin into a checkout of getdomovoi/osnova-claude-plugin, the repository the Claude plugin
# directory reads. The directory blocks this repository because its pnpm-workspace.yaml has an allowBuilds key, so the
# plugin is published from a repository that holds only the plugin. integrations/claude-code stays the source of truth.
# Usage: scripts/sync-claude-plugin.sh <plugin-repository-checkout>
set -eu

dest=${1:?usage: sync-claude-plugin.sh <plugin-repository-checkout>}
root=$(cd "$(dirname "$0")/.." && pwd)

if [ ! -d "$dest/.git" ]; then
  echo "sync-claude-plugin: $dest is not a git checkout" >&2
  exit 1
fi

find "$dest" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R "$root/integrations/claude-code/." "$dest/"
cp "$root/LICENSE" "$root/NOTICE" "$dest/"
