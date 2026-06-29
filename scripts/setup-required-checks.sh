#!/usr/bin/env bash
# scripts/setup-required-checks.sh
#
# Maintainer helper: add the coverage and cold-install jobs to the required
# status checks on the main branch via the GitHub API.  Run once with a
# repo-admin token; the script unions with the existing required set so no
# pre-existing check is removed.
#
# IMPORTANT: The check names in WANT_CHECKS below MUST match the check-run
# display names shown on the Checks tab of a recent CI run (job `name:` in
# .github/workflows/ci.yml).  A name mismatch creates a required check that
# can never be satisfied — verify against an actual CI run before renaming.
#
# Prerequisites:
#   - gh CLI installed and authenticated (run: gh auth status)
#   - jq 1.6+ installed (https://jqlang.github.io/jq/)
#   - Caller must have repository admin permission on this repository
#   - The gh token must include the `repo` scope

set -euo pipefail

# Required check-run display names — must match job `name:` in ci.yml exactly.
WANT_CHECKS=(
  "Format, lint, typecheck & test"
  "Coverage report"
  "Cold-install smoke (fresh node_modules from lockfile)"
)

# ── preflight ────────────────────────────────────────────────────────────────
if ! command -v gh &>/dev/null; then
  echo "error: gh CLI not found — install from https://cli.github.com" >&2
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "error: jq not found — install from https://jqlang.github.io/jq/" >&2
  exit 1
fi

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null) || {
  echo "error: could not detect GitHub repository — is gh authenticated?" >&2
  echo "       run: gh auth status" >&2
  exit 1
}

BRANCH="main"
API="repos/${REPO}/branches/${BRANCH}/protection/required_status_checks"

printf 'repo   : %s\nbranch : %s\n' "${REPO}" "${BRANCH}"

# ── read current required status checks ─────────────────────────────────────
echo "reading current required status checks..."

TMP_ERR=$(mktemp)
TMP_PAYLOAD=$(mktemp)
trap 'rm -f "${TMP_ERR}" "${TMP_PAYLOAD}"' EXIT

STRICT="false"
EXISTING_CHECKS=()

if CURRENT_RESPONSE=$(gh api "${API}" 2>"${TMP_ERR}"); then
  STRICT=$(echo "${CURRENT_RESPONSE}" | jq -r '.strict // false')
  while IFS= read -r name; do
    [[ -n "${name}" ]] && EXISTING_CHECKS+=("${name}")
  done < <(
    echo "${CURRENT_RESPONSE}" | jq -r '
      if .checks then .checks[].context
      elif .contexts then .contexts[]
      else empty
      end
    '
  )
else
  GH_ERR=$(cat "${TMP_ERR}")
  if echo "${GH_ERR}" | grep -qiE "Branch not protected|not protected|404|Not Found"; then
    echo "note: no existing required-check protection — will create from scratch"
  else
    echo "error: cannot read branch protection" >&2
    echo "       ensure you have repo admin permission and that your gh token includes the 'repo' scope" >&2
    echo "       gh error: ${GH_ERR}" >&2
    exit 1
  fi
fi

# ── determine which checks need to be added ───────────────────────────────────
MISSING=()
for CHECK in "${WANT_CHECKS[@]}"; do
  FOUND=0
  if [[ ${#EXISTING_CHECKS[@]} -gt 0 ]]; then
    for EXISTING in "${EXISTING_CHECKS[@]}"; do
      if [[ "${EXISTING}" == "${CHECK}" ]]; then
        FOUND=1
        break
      fi
    done
  fi
  if [[ ${FOUND} -eq 0 ]]; then
    MISSING+=("${CHECK}")
    echo "  + will add : ${CHECK}"
  else
    echo "  ✓ present  : ${CHECK}"
  fi
done

if [[ ${#MISSING[@]} -eq 0 ]]; then
  echo "all required checks already present — nothing to do"
  exit 0
fi

# ── build union payload ───────────────────────────────────────────────────────
ALL_CHECKS=()
if [[ ${#EXISTING_CHECKS[@]} -gt 0 ]]; then
  ALL_CHECKS+=("${EXISTING_CHECKS[@]}")
fi
ALL_CHECKS+=("${MISSING[@]}")

printf '%s\n' "${ALL_CHECKS[@]}" \
  | jq -R '{context: .}' \
  | jq -s --argjson strict "${STRICT}" '{strict: $strict, checks: .}' \
  > "${TMP_PAYLOAD}"

# ── apply ─────────────────────────────────────────────────────────────────────
echo "applying update..."
if ! gh api --method PATCH "${API}" --input "${TMP_PAYLOAD}" >/dev/null 2>"${TMP_ERR}"; then
  GH_ERR=$(cat "${TMP_ERR}")
  echo "error: PATCH failed — caller must have repository admin permission and repo scope" >&2
  echo "       gh error: ${GH_ERR}" >&2
  exit 1
fi

echo "done — required status checks on '${BRANCH}' now include all three checks"
