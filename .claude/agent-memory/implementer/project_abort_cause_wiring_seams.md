---
name: abort-cause-wiring-seams
description: Where AbortCause can and cannot be stamped in-process — the block path is the ONE aborted settle; fatal codes never reach a settle
metadata:
  type: project
---

`AbortCause` (`domain/entity/attempt.ts`) is only ever stamped on an attempt whose status is `aborted`, and
in-process there is exactly ONE such settle: the `blockedReason` branch of `settleTask`
(`business/task/settle-attempt.ts`). Everything else settles `verified` / `failed` / `malformed`, where
`completeAttempt` drops abort metadata entirely.

Wired (#289, 2026-08-18):

- block path default → `self-blocked` (new member; also in `attempt.schema.ts`, `zeroAbortCause`,
  `ABORT_ORDER`, `abortCauseLabel`, and the duplicated inline union in `business/sprint/render-journal-entry.ts`
  — that copy is NOT derived from the domain type and breaks typecheck if you forget it).
- crash-driven block → `watchdog-killed` / `process-crash` + `signalOrExitCode`. Path:
  `classify-spawn-exit` builds `ProcessCrashError{signalOrExitCode, watchdogKilled}` →
  `abortCauseFromError` (business) → the `crashed` GenEvalExit variant → ctx.lastExit → settle leaf's
  `projectCrashAttribution`. The watchdog marker is set in `run-provider-attempt.createIdleTelemetry`
  (the single shared `onIdle` site) because a watchdog SIGTERM and an external kill have identical exit shapes.
  Note this only reaches an `aborted` attempt on the LEGACY-budget crash block (`resolveCrashedRemedy`);
  a modern task's crash retries and settles `failed` with a `crashed` warning, which is correct.

**Deliberately unwired:** `rate-limit-exhausted` and `user-cancel`. `isFatalChainError` (Aborted / RateLimit)
makes the turn use case return `Result.error`, which tears down the per-task subchain — no settle runs, so the
attempt stays `running` and the next launch's `start-attempt` resume stamps the conservative `process-crash`.
Wiring them needs a settle-then-re-raise seam; an in-leaf settle is an `onError` primitive in disguise (banned)
AND would be clobbered on the parallel path by the epilogue's `save-tasks` leaf persisting the stale in-memory
running attempt. The honest placement is above the chain (launcher's runner-event subscription, after the
epilogue) — deferred with the process-level SIGINT/SIGTERM work.

**How to apply:** before adding a new `AbortCause` member or claiming a cause is "recorded", check which settle
transition actually produces `aborted`. See [[project_recoverable_turn_error_policy]] for the turn-error split
that decides `crashed` vs `self-blocked` vs propagate.
