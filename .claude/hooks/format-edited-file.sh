#!/usr/bin/env bash
# PostToolUse hook — format the file Claude just edited with the repo's own prettier.
#
# Why: keeps in-session edits formatted immediately, so diffs stay clean and the
# pre-commit lint-staged pass has nothing to fix. It is deliberately NON-BLOCKING —
# a formatting hiccup must never block or undo an edit, so every path exits 0.
#
# Reads the Claude Code PostToolUse stdin payload ({ tool_input: { file_path } }).
# Parses with node (guaranteed in this repo) rather than jq, so it has no extra dep.
set -uo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

FILE="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s)?.tool_input?.file_path||""))}catch{}})' 2>/dev/null)"

[ -n "$FILE" ] && [ -f "$FILE" ] || exit 0

# Only format files inside this project — never reach out to edited files elsewhere
# (e.g. a global memory file or a sibling repo). prettier's own project resolution
# would no-op on outsiders anyway, but this makes the intent explicit and skips the spawn.
case "$FILE" in
  "$PROJECT_DIR"/*) ;;
  *) exit 0 ;;
esac

case "$FILE" in
  *.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs | *.json | *.md | *.yml | *.yaml | *.css)
    PRETTIER="$PROJECT_DIR/node_modules/.bin/prettier"
    [ -x "$PRETTIER" ] && "$PRETTIER" --write --log-level=warn "$FILE" >/dev/null 2>&1 || true
    ;;
esac

exit 0
