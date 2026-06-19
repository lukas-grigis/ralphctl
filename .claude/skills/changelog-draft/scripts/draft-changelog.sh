#!/usr/bin/env bash
# changelog-draft — draft a CHANGELOG [Unreleased] block from commits since the last tag.
#
# Output is a STARTING POINT, not a finished changelog. It groups conventional-commit
# subjects into Keep-a-Changelog sections by a rough type→section map. The changelog is
# user-facing prose; the agent must curate: rewrite terse subjects into user-readable
# lines, merge related commits, and drop pure-internal churn. The script only saves the
# blank-page step. Exit 0 always.
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT" || exit 0

RANGE="${1:-}"
if [ -z "$RANGE" ]; then
  LAST_TAG="$(git describe --tags --abbrev=0 2>/dev/null || true)"
  RANGE="${LAST_TAG:+$LAST_TAG..}HEAD"
fi
echo "# changelog draft — commits in: ${RANGE}"
echo "# Curate before pasting under '## [Unreleased]' in CHANGELOG.md. Drop internal-only lines."
echo

# Group on SUBJECT lines only (commit bodies are scanned separately for BREAKING).
subjects="$(git log --no-merges --pretty='%s' "$RANGE" 2>/dev/null)"

emit() { # $1 = section title, $2 = grep-extended type pattern (anchored)
  local title="$1" pat="$2" out
  out="$(printf '%s\n' "$subjects" \
    | grep -iE "^($pat)(\([a-z0-9 -]+\))?!?:" 2>/dev/null \
    | sed -E "s/^($pat)(\([a-z0-9 -]+\))?!?: */- /")"
  [ -n "$out" ] && { echo "### $title"; echo "$out"; echo; }
}

# Breaking first — a '!' after the type in the subject, or a 'BREAKING CHANGE' body trailer.
breaking="$(
  { printf '%s\n' "$subjects" | grep -iE '^[a-z]+(\([a-z0-9 -]+\))?!:'
    git log --no-merges --pretty='%s%x1e%b' "$RANGE" 2>/dev/null \
      | awk 'BEGIN{RS="\036"} /BREAKING CHANGE/{sub(/\n.*/,"",$0); print}'
  } 2>/dev/null | sed -E 's/^[a-z]+(\([a-z0-9 -]+\))?!?: */- /' | sort -u)"
[ -n "$breaking" ] && { echo "### Breaking"; echo "$breaking"; echo; }

emit "Added"   "feat"
emit "Fixed"   "fix"
emit "Changed" "perf|refactor"
echo "### Removed"
echo "- (scan the Changed/Fixed lines above for anything that REMOVED a feature/flag/command)"
echo

echo "## Internal — usually omit from a user-facing changelog (verify none are user-visible)"
printf '%s' "$commits" | tr '\036' '\n' \
  | grep -iE '^(chore|docs|test|ci|style|build|deps)(\([a-z0-9 -]+\))?:' 2>/dev/null \
  | sed -E 's/^/  /' | sed -E 's/\t.*//' | head -40
echo
echo "# Done. Rewrite each kept line for a user reading release notes — not the commit author."
