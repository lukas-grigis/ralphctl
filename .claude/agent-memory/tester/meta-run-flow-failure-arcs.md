---
name: meta-run-flow-failure-arcs
description: tests/e2e/meta-flows/run.test.ts implement-failure and review-failure arcs — RateLimitError yields 'failed' not 'aborted'; review termination vs failure distinction
metadata:
  type: feedback
---

`tests/e2e/meta-flows/run.test.ts` failure arcs:

- Implement-failure: `makeDoneSprint()` → `loadAndAssertSprintSubChain` fails → review never
  starts → `feedback.md` never created, runner `status==='failed'`, trace ends with
  `{ elementName: 'run', status: 'failed' }`.
- Review-failure: `passingProvider` for implement + `failingReviewProvider` (RateLimitError) +
  `reviewFailingInteractive` (`askTextArea` returns a non-empty body) → implement succeeds, sprint
  reaches 'review', review-round fails → runner `status==='failed'`, `feedback.md` exists
  (ensureFeedbackFile ran), trace contains 'load-sprint' (implement) + 'review-round' (review
  failure).

**`RateLimitError` is NOT Aborted** — `runner.status` becomes `'failed'`, not `'aborted'`.
`AbortError` → `'aborted'`.

**Review termination**: `terminatingInteractive.askTextArea` returning `''` leads to
`isTerminationRound=true` → review SUCCEEDS (exit='terminated'). For review to genuinely fail,
provide a non-empty body AND use a provider that returns `RateLimitError`.
