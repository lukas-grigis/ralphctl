#!/usr/bin/env bash
# flow-trace-sync — extract the REAL element-name sequence of each chain flow, so the
# step-traces written in docs (KERNEL-DESIGN, diagrams, REQUIREMENTS) can be checked
# against what the code actually runs.
#
# The canonical order lives in two places the code owns: the flow definition
# (`leaf/sequential/guard/loop('<name>', …)` calls) and the step-order fence TEST
# (which asserts `trace.map(s => s.elementName)`). Docs paraphrase those and drift.
# This prints the code's view; the agent diffs the docs against it. Exit 0 always.
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT" || exit 0

FLOWS_DIR="src/application/flows"
[ -d "$FLOWS_DIR" ] || { echo "flow-trace-sync: no $FLOWS_DIR"; exit 0; }

ONE="${1:-}" # optional: limit to a single flow name

echo "# flow-trace-sync — real element names per flow (source of truth for documented step-traces)"
echo "# Compare these against: KERNEL-DESIGN.md examples, .claude/docs/diagrams/, REQUIREMENTS step lists."
echo

for dir in "$FLOWS_DIR"/*/; do
  flow="$(basename "$dir")"
  [ "$flow" = "_shared" ] && continue
  [ -n "$ONE" ] && [ "$flow" != "$ONE" ] && continue

  echo "## flow: $flow"

  # Element-name constructors, in file order. Captures the first quoted arg of each
  # leaf/sequential/guard/loop call (template names like 'task-<id>' included).
  names="$(grep -rhoE "(leaf|sequential|guard|loop)\(\s*'[^']+'" "$dir" 2>/dev/null \
    | sed -E "s/.*\(\s*'([^']+)'.*/\1/" | awk '!seen[$0]++')"
  if [ -n "$names" ]; then
    echo "  elements (definition order, deduped):"
    printf '%s\n' "$names" | sed 's/^/    - /'
  else
    echo "  (no inline element-name constructors found — flow may compose shared subchains; read $dir)"
  fi

  # The fence test asserts the canonical runtime sequence — point at it.
  fence="$(grep -rl "elementName" "tests/integration/application/flows/$flow" 2>/dev/null | head -1)"
  [ -n "$fence" ] && echo "  canonical sequence asserted in: $fence"
  echo
done

echo "# Next: for each documented trace, confirm its order/names match the lists above."
echo "# Docs may legitimately SIMPLIFY — that's fine if labelled 'simplified'; a WRONG order or a"
echo "# renamed/removed element is real drift to fix."
