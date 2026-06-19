#!/usr/bin/env bash
# drift-sweep — surface CANDIDATE drift in .claude/ + CLAUDE.md against the real code.
#
# This is a grep harness, not a verdict. Every line it prints is a candidate the
# caller must verify by reading the real source — some candidates are legitimate
# (e.g. `signals.json` is a real runtime filename even though the `signals/` dir
# was renamed to `contract/`). The script does the mechanical grunt-work; judgement
# stays with the agent. Exit code is always 0 — "found candidates" is not a failure.
set -uo pipefail

ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT" || { echo "drift-sweep: cannot cd to $ROOT" >&2; exit 0; }

# Scope: the docs/config surfaces that mirror the code and therefore rot.
SCOPE=()
for p in CLAUDE.md .claude/agents .claude/docs .claude/skills; do
  [ -e "$p" ] && SCOPE+=("$p")
done
[ ${#SCOPE[@]} -eq 0 ] && { echo "drift-sweep: no .claude/ or CLAUDE.md found under $ROOT"; exit 0; }

VERSION="$(node -p "require('./package.json').version" 2>/dev/null \
  || sed -nE 's/.*"version" *: *"([^"]+)".*/\1/p' package.json 2>/dev/null | head -1)"

echo "# drift-sweep candidates — repo version: ${VERSION:-unknown}"
echo "# Scope: ${SCOPE[*]}"
echo "# Every line below is a CANDIDATE — verify against real code before reporting it as drift."
echo

# Only markdown mirrors the code; restrict to *.md so the sweep never matches
# bundled scripts. Exclude this skill's own dir — it catalogs drift patterns as
# examples, so it would otherwise flag itself on every run.
MD=(--include='*.md' --exclude-dir='drift-sweep')

echo "## [1] Hardcoded version stamps (each should match ${VERSION:-the current version} or be de-versioned)"
echo "#     Noise expected: external tool versions (Claude Code vX, Copilot vX) and historical migration"
echo "#     notes (v0.6.x → ...) are legitimately pinned. A bare current-feature 'v0.N.0' usually is not."
grep -rnoE "${MD[@]}" "v[0-9]+\.[0-9x]+\.[0-9x]+" "${SCOPE[@]}" 2>/dev/null | sort -t: -k1,1 -u | sed 's/^/  /'
echo

echo "## [2] Referenced src/ tests/ scripts/ paths that DO NOT exist on disk"
echo "#     High signal — a referenced file/dir that is gone is almost always real drift."
{
  grep -rhoE "${MD[@]}" "(src|tests|scripts|dist)/[A-Za-z0-9_./-]+\.(ts|tsx|md|json|mjs|sh)" "${SCOPE[@]}" 2>/dev/null
  grep -rhoE "${MD[@]}" "(src|tests|scripts)/[A-Za-z0-9_./-]+/" "${SCOPE[@]}" 2>/dev/null
} | sort -u | while IFS= read -r ref; do
  [ -e "$ref" ] || echo "  MISSING: $ref"
done
echo

echo "## [3] RALPHCTL_* env vars named in docs but never read in src/ (unshipped or removed)"
echo "#     Cross-checks each documented env var against an actual read in non-test src."
grep -rhoE "${MD[@]}" "RALPHCTL_[A-Z_]+" "${SCOPE[@]}" 2>/dev/null | sort -u | while IFS= read -r v; do
  hits="$(grep -rl "$v" src 2>/dev/null | grep -vc '\.test\.' || true)"
  [ "${hits:-0}" -eq 0 ] && echo "  UNREAD: $v (0 non-test reads in src/)"
done
echo

echo "## [4] Known stale-path patterns (renames that recur)"
echo "#     Extend this list as new renames land — it is the cheapest early-warning."
grep -rnE "${MD[@]}" "tests/integration/flows/|ai/\{[^}]*signals|runtime/mount\.tsx|InkPromptAdapter|PromptPort\b" "${SCOPE[@]}" 2>/dev/null | sed 's/^/  /'
echo

echo "## [5] Backticked code symbols to spot-check (sample — verify the load-bearing ones in src/)"
echo "#     Too noisy to auto-resolve; the agent greps the suspicious ones. Listing distinct PascalCase/camelCase idents."
grep -rhoE "${MD[@]}" '`[a-z][a-zA-Z0-9]+\(|`[A-Z][a-zA-Z0-9]+`' "${SCOPE[@]}" 2>/dev/null \
  | tr -d '`(' | sort -u | head -40 | sed 's/^/  /'
echo

echo "# Done. Next: for each candidate above, Read/Grep the real source to confirm before reporting."
