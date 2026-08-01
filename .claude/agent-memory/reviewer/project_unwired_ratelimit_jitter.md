---
name: unwired-ratelimit-jitter
description: 'RESOLVED 2026-08-01: applyJitter is now wired into run-with-rate-limit-retry.ts — durable lesson: knip cannot flag test-only exports because tests are entry points'
metadata:
  type: project
---

RESOLVED: `applyJitter` was wired into `handleRateLimitOutcome` in `run-with-rate-limit-retry.ts`
(the `delayForRetry(...) → sleepCancellable(...)` hop) later the same day it was flagged, with an
injectable `random` option on `RunWithRateLimitRetryOptions` and three pinning tests in
`tests/unit/integration/ai/providers/_engine/run-with-rate-limit-retry.test.ts` (+20% / -20% /
zero-delay fast path). 429 backoff is jittered production behaviour now.

**Durable lesson (still true):** `pnpm deadcode` stays green for an export used only by tests,
because `knip.json` lists `tests/**/*.test.ts` as entry points. "It has tests and knip is green"
does NOT prove a production caller exists — grep `src/` for a non-test call site before citing a
mechanism as shipped behaviour (release notes, PERFORMANCE.md, a harness review).

Related: [[project_model_refresh_review_2026-07-26]]
