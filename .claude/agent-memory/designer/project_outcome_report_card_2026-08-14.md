---
name: project_outcome_report_card_2026-08-14
description: Sprint outcome-report card design — host location, minimal metric set, no-data fallback for the harness-outcome rollup (feature/harness-outcome-rollup, 2026-08-14)
metadata:
  type: project
---

Council-scoped TUI surface for `src/business/runs/outcome-stats.ts`'s `foldOutcomeStats` fold
landed on `feature/harness-outcome-rollup` (2026-08-14). Deliberately minimal — no
progress-journal/PR block, no cross-sprint trends, no new CLI surface (those were explicitly
ruled out).

**Host: `SprintDetailView`'s `Body`, not a dedicated close/summary view.** No sprint-close /
sprint-summary view exists — `sprint-detail-view.tsx` (via `detail-content.tsx`'s `Body`) is
already the surface the operator lands on when a sprint reaches `review`/`done`, and it already
loads `{ sprint, tasks }` as a `SprintBundle` (`sprint-detail-internals/use-sprint-bundle.ts`).
Embedding there avoids a second loader and matches "least invasive host".

**Card:** `sprint-detail-internals/outcome-card.tsx` → `OutcomeReportCard`. Folds the ALREADY
LOADED `tasks` via `foldOutcomeStats([{ sprint, tasks }])` and reads `.totals` — no new I/O.
Rendered in `Body` right after `NextPhaseCard`, gated on `sprint.status === 'review' ||
sprint.status === 'done'` (the fold has nothing to say pre-attempt).

**Minimal metric set (deliberately dropped attempts-to-done + failed-dimension histogram):**
outcome mix (`doneClean`/`doneWithWarning`/`blocked`/`open` on one line), first-pass rate,
plateau-by-source (only nonzero sources, else `'none'`), escalation-rung efficacy as one
`FieldList` row per rung with `granted > 0` only (label `Model`/`Effort`/`Evaluator
effort`/`Nudge`/`Best-of-N`, value `N granted · M resolved`), criteria k/N with an `unknown`
suffix when nonzero.

**Graceful empty state:** `hasAttemptData(rollup)` — true when `doneTotal > 0 ||
attemptsWithPlateau > 0 || criteria.declared > 0 || any escalation.granted > 0`. False (an
empty-tasks or fully pre-attempt sprint) renders a single dim `Card tone="rule"` line, "No
attempt data recorded for this sprint." — never crashes. **Gotcha:** `criteria.declared` is
populated from a task's _declared_ `verificationCriteria` checklist regardless of whether any
verdict was ever recorded (see `absorbCriteria` in outcome-stats.ts) — so a fresh `todo` task
with criteria authored but zero attempts still counts as "has data" by this predicate. Test
fixtures for the true empty case use `tasks: []`, not a single unattempted task.

**Tone:** `Card tone="info"` for the populated state (neutral report, not a health check —
distinct from the pass/fail accent rules in [[feedback_baseline_card_row_pattern]], which apply
to status/health cards, not outcome rollups). `tone="rule"` (recessive) for the empty fallback.

Files: `src/application/ui/tui/views/sprint-detail-internals/outcome-card.tsx` (new),
`sprint-detail-internals/detail-content.tsx` (wiring, one gated `<OutcomeReportCard>` insert),
`tests/integration/application/ui/tui/views/sprint-detail-outcome-card.test.tsx` (new — populated

- empty cases, built from real domain-entity fixtures mirroring
  `tests/unit/business/runs/outcome-stats.test.ts`'s pattern, not ad-hoc object literals).
