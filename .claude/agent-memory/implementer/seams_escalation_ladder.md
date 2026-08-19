---
name: seams_escalation_ladder
description: The escalation subsystem — which exits consult the policy, the provider/model-aware effort rung and its wiring path, and where AbortCause can actually be stamped
metadata:
  type: project
---

Files: `business/task/escalation-policy.ts`, `business/task/escalation-map.ts`,
`business/task/finalize-gen-eval.ts`, `domain/entity/task-settle.ts`, `domain/entity/attempt.ts`.

## Which exits consult the policy

`finalize-gen-eval.ts` gates on `isEscalatableExit(exit)` — `'plateau' | 'budget-exhausted'`. It used to
be plateau-only, which made the attempt budget, the ladder, fresh-session retry and the nudge all
unreachable for the most common failure shapes.

| Exit                       | Flag on, budget remaining                                                                          | Otherwise         |
| -------------------------- | -------------------------------------------------------------------------------------------------- | ----------------- |
| passed / self-blocked      | no remedy — settle handles it directly                                                             | —                 |
| plateau / budget-exhausted | escalate/nudge stamps + `shouldFailAttempt`                                                        | done-with-warning |
| **malformed**              | `shouldFailAttempt` only — **NO ladder rung, no escalatedFrom/To stamp, no model-escalated event** | done-with-warning |

Malformed is the EVALUATOR's failure, not the generator's — burning a ladder rung would target the wrong
role, so it gets a plain same-model fresh-attempt retry.

`settings.harness.escalateOnPlateau` gates ALL failure-driven escalation now, not just plateau. The name
is kept deliberately: renaming it is a breaking settings change.

`EscalationTrigger` (`'plateau' | 'budget-exhausted'`) parameterizes `applyEscalation` /
`ModelEscalatedEvent.reason` so budget-driven escalations are not mislabeled. `reason` is emit-only — no
subscriber pattern-matches it — so widening it stays safe.

**Legacy-task budget fallback:** `decideEscalation` takes `fallbackMaxAttempts`, wired from
`settings.harness.maxAttempts` through the `maxTurns/escalateOnPlateau/escalationMap` readConfig slice
(declared at ~6 sites: finalize business + leaf, per-task-subchain, flow.ts, wave-branch.ts,
launch/implement.ts, flow-shape.test). Effective budget is `task.maxAttempts ?? fallback`; the
per-task-subchain loop mirrors it as `maxIterations`.

**Unreachable branch, do not "fix" it:** `failCurrentAttempt`'s blocked-at-cap branch cannot be reached
from the escalation path — `decideEscalation` PRE-EMPTS at the cap (returns budget-exhausted →
done-with-warning, never sets `shouldFailAttempt`), so settle marks `done`, not `blocked`.

## The effort rung

`decideEscalation` carries an `escalate-effort` rung at the top of the MODEL ladder — after a model jump
is exhausted, before the same-model change-of-approach `nudge`. Cheapest-first: an effort bump costs less
than a model jump, and placing it AFTER the model jump leaves economic-preset model climbs unchanged.
This fixed the inert default ladder: the shipped generator sits at the model-ladder top, so it previously
went straight to nudge.

`applyEscalation`'s `escalate-effort` case stamps NO model fields and emits the generic `banner-show`
event — there is no new event type and no UI file reads the escalation fields directly.

**`nextEffortRung(provider, model, currentEffort)` is provider- AND model-aware.** A fixed `high` target
was a no-op or an outright DOWNGRADE for claude-code, whose CLI default is already `xhigh` on
xhigh-capable models. All the logic lives in `escalation-map.ts`; effort.ts and domain are untouched and
the catalog fingerprint is not involved.

- **claude-code** (`claudeEffortRung`): Haiku (`CLAUDE_EFFORTLESS_MODELS`) → skip. Effective current =
  explicit effort, else the CLI default (`xhigh` on xhigh-capable, `high` on `CLAUDE_HIGH_DEFAULT_MODELS`).
  Explicit `low|medium|high` on an xhigh-capable model → `xhigh`; `unset|xhigh` (and every tier on a
  non-xhigh model) → `max`; `max` → undefined (spent). Never returns ≤ effective. Ladder is
  `low<medium<high<xhigh<max`, and **xhigh-capable is the DEFAULT assumption for any unrecognised
  claude-code model** — only Sonnet 4.6 and Haiku are exceptions.
- **github-copilot / openai-codex**: fixed target `EFFORT_ESCALATION_TARGET='high'` (that constant is now
  copilot/codex-only); `unset` escalatable, `high|xhigh|max` spent, model ignored.

**Bounded, not unbounded:** exactly ONE fire for the shipped default and for any xhigh/max start; an
explicit sub-xhigh claude effort can fire at most TWICE (e.g. medium→xhigh, then xhigh→max on the finalize
leaf's `escalatedToEffort ?? configured` re-read), because the stamped effort climbs monotonically to the
terminal `max`.

**Wiring path** (launch/implement.ts is UI-fenced, so the value threads through the existing
`GenEvalLoopRoleConfig.{providerId,effort}`):

1. `per-task-subchain.ts` passes `configuredGeneratorProvider` + `configuredGeneratorEffort` into
   `finalizeGenEvalLeaf` deps.
2. The finalize LEAF forwards `generatorProvider` and
   `generatorEffort = ctx.currentTask.escalatedToEffort ?? configured` into `finalizeGenEvalUseCase`.
3. `resolveEscalatableRemedy` passes them to `decideEscalation`; on `escalate-effort` it stamps via
   `recordTaskEffortEscalation` (`task-settle.ts`) and adds `escalate-effort` to `shouldFailAttempt`.
4. `generator.ts` reads `effectiveEffort = task.escalatedToEffort ?? deps.effort` at the initial spawn and
   threads it into `makeGeneratorReinvoke`.

`Task.escalatedToEffort` is a re-stampable optional (`z.string().optional()` in task.schema.ts), carried
by `markTaskDone` and stripped by `unblockTask`.

**Test gotcha:** under the default posture the effort rung inserts a step, so a graduated-ladder e2e's
attempt 2 is the effort bump rather than the nudge — model fields stay untouched and the budget can
exhaust before the nudge is ever reached.

## Where AbortCause can be stamped

`AbortCause` (`domain/entity/attempt.ts`) is only ever stamped on an attempt whose status is `aborted`,
and in-process there is exactly ONE such settle: the `blockedReason` branch of `settleTask`
(`business/task/settle-attempt.ts`). Every other path settles `verified` / `failed` / `malformed`, where
`completeAttempt` drops abort metadata entirely.

Wired:

- block path default → `self-blocked`. Adding a member means touching `attempt.schema.ts`,
  `zeroAbortCause`, `ABORT_ORDER`, `abortCauseLabel`, **and the duplicated inline union in
  `business/sprint/render-journal-entry.ts`** — that copy is not derived from the domain type and breaks
  typecheck if you forget it.
- crash-driven block → `watchdog-killed` / `process-crash` + `signalOrExitCode`. Path:
  `classify-spawn-exit` builds `ProcessCrashError{signalOrExitCode, watchdogKilled}` →
  `abortCauseFromError` → the `crashed` GenEvalExit variant → `ctx.lastExit` → the settle leaf's
  `projectCrashAttribution`. The watchdog marker is set in `run-provider-attempt.createIdleTelemetry` (the
  single shared `onIdle` site) because a watchdog SIGTERM and an external kill have identical exit shapes.
  This only reaches an `aborted` attempt on the legacy-budget crash block (`resolveCrashedRemedy`); a
  modern task's crash retries and settles `failed` with a `crashed` warning, which is correct.

**Deliberately unwired: `rate-limit-exhausted` and `user-cancel`.** `isFatalChainError` (Aborted /
RateLimit) makes the turn use case return `Result.error`, tearing down the per-task subchain — no settle
runs, the attempt stays `running`, and the next launch's `start-attempt` resume stamps the conservative
`process-crash`. Wiring them needs a settle-then-re-raise seam: an in-leaf settle is an `onError`
primitive in disguise (banned) AND would be clobbered on the parallel path by the epilogue's `save-tasks`
leaf persisting the stale in-memory running attempt. The honest placement is above the chain (the
launcher's runner-event subscription, after the epilogue), deferred with the process-level
SIGINT/SIGTERM work.

**How to apply:** before adding a new `AbortCause` member or claiming a cause is "recorded", check which
settle transition actually produces `aborted`.

Related: [[seams_plateau_and_turn_errors]], [[seams_attempt_ctx_and_telemetry]],
[[seams_model_catalog_refresh]].
