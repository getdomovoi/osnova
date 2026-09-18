#!/usr/bin/env bash
# Compare the call graph of a base commit with the checked-out head and report every indexed
# dependent of the changed symbols. Used by action.yml; runnable by hand.
#   OSNOVA    command that runs osnova (default: npx -y @getdomovoi/osnova)
#   BASE_REF  commit or ref to compare against (required)
#   DEPTH     dependent depth (default 1)
#   WORKSPACE repository root (default: current directory)
#   REPORT    file to write the report to (default: osnova-settle.txt in the runner temp dir)
set -euo pipefail
OSNOVA=${OSNOVA:-"npx -y @getdomovoi/osnova"}
DEPTH=${DEPTH:-1}
WORKSPACE=$(cd "${WORKSPACE:-.}" && pwd)
TEMP=${RUNNER_TEMP:-${TMPDIR:-/tmp}}
REPORT=${REPORT:-"$TEMP/osnova-settle.txt"}
[ -n "${BASE_REF:-}" ] || { echo "osnova settle: BASE_REF is required" >&2; exit 2; }
cd "$WORKSPACE"
head=$(git rev-parse HEAD)
git rev-parse --verify --quiet "${BASE_REF}^{commit}" >/dev/null || git fetch --quiet --depth=1 origin "$BASE_REF"
base=$(git rev-parse "${BASE_REF}^{commit}")
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "osnova settle: the working tree has uncommitted changes" >&2; exit 2; }
base_cache="$TEMP/osnova-settle-base"
head_cache="$TEMP/osnova-settle-head"
rm -rf "$base_cache" "$head_cache"
git checkout --quiet --detach "$base"
$OSNOVA build "$WORKSPACE" --cache-dir "$base_cache" >/dev/null
git checkout --quiet "$head"
$OSNOVA build "$WORKSPACE" --cache-dir "$head_cache" >/dev/null
$OSNOVA settle --base-cache "$base_cache" --cache-dir "$head_cache" --workspace "$WORKSPACE" --depth "$DEPTH" > "$REPORT"
cat "$REPORT"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## osnova settle"
    echo
    echo "Dependents of the symbols changed between \`${base:0:12}\` and \`${head:0:12}\`, depth $DEPTH. Indexed structural evidence only; absence of a dependent is not proof that nothing depends on the change."
    echo
    echo '```'
    cat "$REPORT"
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"
fi
echo "report=$REPORT" >> "${GITHUB_OUTPUT:-/dev/null}"
