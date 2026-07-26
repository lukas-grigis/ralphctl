---
name: gen-eval-exit-mapping
description: finalize-gen-eval mapExit verdict/warning/blockedReason truth table — use when writing or auditing gen-eval loop assertions
metadata:
  type: feedback
---

`finalize-gen-eval` `mapExit` semantics — important for writing correct assertions:

- `passed` → `{ verdict: 'passed' }` — NO warning, NO blockedReason.
- `self-blocked` → `{ verdict: 'failed', blockedReason }` — NO warning.
- `malformed` → `{ verdict: 'malformed', warning: { kind: 'malformed', detail } }`.
- `plateau` → `{ verdict: 'failed' }` — NO warning (plateau is an escalation trigger, not done-with-warning).
- `budget-exhausted` → `{ verdict: 'failed', warning: { kind: 'budget-exhausted', turnsUsed, turnBudget } }`.

The `shouldFailAttempt` field is controlled by the escalation policy (not `mapExit`), so it can
appear independently of the warning. A mutant test needs to assert BOTH fields explicitly — a
vacuous `if (result.ok && result.value.warning?.kind === 'plateau')` guard always passes and kills
nothing.

See also [[model-catalog-refresh-2026-07-26]] for how "top of ladder" model fixtures in these same
tests break silently when the escalation ladder gains a new rung.
