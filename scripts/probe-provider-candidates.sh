#!/usr/bin/env bash
#
# probe-provider-candidates.sh — capture the live CLI contract shapes for the two
# candidate provider backends tracked in issue #255 (Gemini CLI, OpenCode).
#
# Why this exists: the three shipped adapters (claude / copilot / codex) each needed
# hand-tuning against real output — especially the rate-limit wording and the
# session-id round-trip. This script captures the same evidence for a candidate
# BEFORE any adapter work, so the go/no-go is grounded in output rather than docs.
#
# Usage:
#   scripts/probe-provider-candidates.sh            # probe whichever CLIs are installed
#   scripts/probe-provider-candidates.sh gemini     # probe one tool only
#   scripts/probe-provider-candidates.sh opencode
#
# Install (neither is a project dependency — these are external CLIs):
#   npm i -g @google/gemini-cli opencode-ai
#
# Auth:
#   - OpenCode runs unauthenticated against a bundled free model, so its probes
#     work out of the box.
#   - Gemini requires credentials. The cheapest path is a free AI Studio key:
#       export GEMINI_API_KEY=...
#     (GOOGLE_GENAI_USE_VERTEXAI / GOOGLE_GENAI_USE_GCA are the other accepted modes.)
#
# Output lands in a timestamped directory under ./probe-out/ — raw stdout/stderr per
# probe, so the captured shapes can be pasted into the issue verbatim.

set -uo pipefail

TOOLS=("$@")
if [ ${#TOOLS[@]} -eq 0 ]; then TOOLS=(gemini opencode); fi

OUT_ROOT="probe-out/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT_ROOT"
echo "Writing probe output to $OUT_ROOT"

# Run a probe with a wall-clock cap. `timeout` is not present on a stock macOS, so
# this backgrounds the command and kills it after the deadline.
run_probe() {
  local name="$1" limit="$2"
  shift 2
  local log="$OUT_ROOT/$name.log"
  echo "--- $name"
  {
    echo "\$ $*"
    echo
  } >"$log"
  ( "$@" >>"$log" 2>&1 & local p=$!
    ( sleep "$limit"; kill $p 2>/dev/null ) >/dev/null 2>&1 &
    wait $p )
  echo "    exit=$? -> $log"
}

probe_gemini() {
  if ! command -v gemini >/dev/null 2>&1; then
    echo "!! gemini not installed — skipping (npm i -g @google/gemini-cli)"
    return
  fi
  echo "== gemini $(gemini --version 2>&1 | head -1)"
  run_probe gemini-help 20 gemini --help
  run_probe gemini-list-sessions 20 gemini --list-sessions

  if [ -z "${GEMINI_API_KEY:-}${GOOGLE_GENAI_USE_VERTEXAI:-}${GOOGLE_GENAI_USE_GCA:-}" ]; then
    echo "!! no Gemini credentials in env — flag surface captured, live shapes skipped."
    echo "   Set GEMINI_API_KEY and re-run to capture JSON shapes + resume + quota wording."
    return
  fi

  local work="$OUT_ROOT/gemini-work"
  mkdir -p "$work"

  # The `json` format is documented as { response, stats, error? } with NO session id
  # (upstream google-gemini/gemini-cli#14435). Capture it to confirm on this version.
  run_probe gemini-json 120 gemini -p "Reply with the single word: banana" -o json

  # `stream-json` emits JSONL whose `init` event carries session_id + model. This is the
  # shape an adapter would consume if it needs to READ an id back.
  run_probe gemini-stream-json 120 gemini -p "Reply with the single word: banana" -o stream-json

  # --session-id lets the CALLER supply the UUID, which removes the need to parse an id
  # out of output at all. Probe 1 writes a fact, probe 2 resumes and must recall it.
  local sid
  sid="$(uuidgen | tr '[:upper:]' '[:lower:]')"
  echo "    using session-id $sid"
  run_probe gemini-session-seed 120 \
    gemini -p "Remember the word banana. Reply OK." -o stream-json --session-id "$sid"
  run_probe gemini-session-resume 120 \
    gemini -p "What word did I ask you to remember? One word." -o stream-json --resume "$sid"

  # Approval-mode surface: plan is read-only (blocks the mandatory signals.json write),
  # yolo auto-approves everything. Capture how each behaves against a write request.
  run_probe gemini-approval-plan 120 \
    gemini -p "Create a file banana.txt containing the word banana." \
    -o stream-json --approval-mode plan --include-directories "$work"
  run_probe gemini-approval-yolo 120 \
    gemini -p "Create a file banana.txt containing the word banana." \
    -o stream-json --approval-mode yolo --include-directories "$work"
}

probe_opencode() {
  if ! command -v opencode >/dev/null 2>&1; then
    echo "!! opencode not installed — skipping (npm i -g opencode-ai)"
    return
  fi
  echo "== opencode $(opencode --version 2>&1 | head -1)"
  run_probe opencode-help 20 opencode run --help

  local work="$OUT_ROOT/opencode-work"
  mkdir -p "$work"

  # Baseline text turn — establishes the step_start / text / step_finish event trio and
  # shows that sessionID is present on every event, not just an init frame.
  run_probe opencode-json 90 \
    opencode run --format json --dir "$work" "Reply with the single word: banana"

  # Tool turn under --auto, which is the only approval switch `run` exposes. Captures the
  # tool_use event shape and confirms --dir is honoured as the working root.
  run_probe opencode-tool-auto 120 \
    opencode run --format json --dir "$work" --auto \
    "Create a file named hello.txt containing the word banana, then say done."

  # Resume round-trip: pull the sessionID out of the previous capture and continue it.
  # A correct round-trip means the model recalls `banana` from the prior turn.
  local sid
  sid="$(grep -o '"sessionID":"[^"]*"' "$OUT_ROOT/opencode-tool-auto.log" 2>/dev/null | head -1 | cut -d'"' -f4)"
  if [ -n "$sid" ]; then
    echo "    resuming $sid"
    run_probe opencode-resume 90 \
      opencode run --format json --dir "$work" -s "$sid" \
      "What word did you just put in that file? One word answer."
  else
    echo "!! could not extract a sessionID — resume probe skipped"
  fi

  # Nonexistent session id: an adapter needs to know whether a stale resume errors loudly
  # or silently starts a fresh session (the codex adapter cold-falls-back on stale resume).
  run_probe opencode-stale-resume 90 \
    opencode run --format json --dir "$work" -s ses_thisdoesnotexist000000000 "Reply OK."
}

for t in "${TOOLS[@]}"; do
  case "$t" in
    gemini) probe_gemini ;;
    opencode) probe_opencode ;;
    *) echo "!! unknown tool '$t' (expected: gemini | opencode)" ;;
  esac
done

echo
echo "Done. Captured shapes are under $OUT_ROOT — paste the relevant logs into issue #255."
