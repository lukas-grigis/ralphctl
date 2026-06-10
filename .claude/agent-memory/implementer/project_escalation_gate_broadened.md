---
name: escalation-gate-broadened
description: finalize-gen-eval consults escalation policy for plateau AND budget-exhausted AND malformed (not just plateau); malformed gets same-model retry, no ladder rung
metadata:
  type: project
---

`src/business/task/finalize-gen-eval.ts` used to consult `decideEscalation` ONLY for `exit.kind === 'plateau'`.
Budget-exhausted (real + the synthesized one when no leaf wrote a terminal exit) and malformed fell straight to
done-with-warning on attempt 1 — so the attempt budget, escalation ladder, fresh-session retry, and
change-of-approach nudge were unreachable for the most common failure shapes.

Now gated via `isEscalatableExit(exit)` (`'plateau' | 'budget-exhausted'`) → consults policy. Mapping table
(exit kind × budget → outcome), all gated by `escalateOnPlateau` (flag name kept; it now gates ALL
failure-driven escalation, NOT just plateau — renaming is a breaking change):

- passed / self-blocked → no remedy (settle handles directly)
- plateau / budget-exhausted + flag-on + budget remaining → escalate/nudge stamps + `shouldFailAttempt`
- plateau / budget-exhausted + budget exhausted OR topped-out OR flag-off → done-with-warning
- **malformed** + flag-on + budget remaining → `shouldFailAttempt` but **NO model escalation, NO
  escalatedFrom/To stamp, NO model-escalated event** — it's the EVALUATOR's failure, not the generator's, so
  burning a ladder rung would target the wrong role. Plain same-model fresh-attempt retry. Falls back to
  done-with-warning at budget.

**Trigger parameterization:** `applyEscalation` / `ModelEscalatedEvent.reason` widened from literal `'plateau'`
to `'plateau' | 'budget-exhausted'` (`EscalationTrigger` type in escalation-policy.ts) so budget-driven
escalations aren't mislabeled. `reason` is emit-only — no subscriber pattern-matches its value (notification
classify returns undefined for model-escalated), so widening is safe.

**Legacy-task budget fallback:** `decideEscalation` gained `fallbackMaxAttempts` (wired from
`settings.harness.maxAttempts` through the readConfig slice — `maxTurns/escalateOnPlateau/escalationMap` slice
declared at ~6 sites: finalize biz+leaf, per-task-subchain, flow.ts, wave-branch.ts, launch/implement.ts,
flow-shape.test). Effective budget = `task.maxAttempts ?? fallback` (legacy tasks lack the per-task cap stamped
since commit 3992de36). Mirrored in per-task-subchain.ts loop `maxIterations: task.maxAttempts ?? deps.config.harness.maxAttempts`.

**Stale-comment fix:** `failCurrentAttempt`'s blocked-at-cap branch is UNREACHABLE from the escalation path —
`decideEscalation` PRE-EMPTS at the cap (returns budget-exhausted → done-with-warning, never sets
shouldFailAttempt). The cap is checked before the final attempt would run, so settle marks `done`, not `blocked`.
See [[project_maxattempts_not_enforced]] (user auto-memory) for the original gap this addresses.
