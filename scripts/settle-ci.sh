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
cache="$TEMP/osnova-settle-cache"
rm -rf "$cache"
$OSNOVA settle --base-ref "$base" --workspace "$WORKSPACE" --cache-dir "$cache" --depth "$DEPTH" > "$REPORT"
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
