---
name: run-scoped-ctx-marker-fences
description: Adding a run-scoped ImplementCtx field requires updating THREE merge-wave fences, not just the leaf that sets it
metadata:
  type: project
---

A new `ImplementCtx` field that is run-scoped (lives only on ctx for one launch, like `execution`) must be
threaded through the parallel-path projection in `application/flows/implement/merge-wave.ts` or typecheck
fails. There are THREE coupled sites:

1. `_exhaustive` map (`satisfies Record<keyof ImplementCtx, MergeClass>`) — a compile-time forcing function:
   the literal stops satisfying the constraint until you classify the new field (`SPRINT` / `TASKS` /
   `PER_TASK` / `SIGNAL_ACCUM`). Run-scoped → `SPRINT`.
2. `mergeImplementWave` hand-written projection — carry the field verbatim from `base` (run-scoped survives
   between waves, like `execution`).
3. `forkCtx` — spread the field into each branch's `initialCtx` so a parallel branch inherits it.

**Why:** the `_exhaustive` guard reads NOTHING at runtime; it exists purely so a future ctx field can never
silently skip the merge/fork projection. Miss site 2 or 3 and the field is silently dropped in parallel mode
even though typecheck passed (the guard only forces classification, not correct carry).

**How to apply:** T13 (feat/gen-eval-speed) added `setupVerifiedRepoIdsThisRun` (run-scoped set of repo ids
whose setup ran green THIS launch). Set by `setup-script-runner` output projection (only on the fresh green-run
path — NOT resume-skip, NOT no-script-skip; those successes belong to a prior launch / validate nothing). Read
by `pre-task-verify`'s fresh-setup short-circuit. Note `priorPostVerifyOutcome` is deliberately DROPPED in
`forkCtx` (per-task, accepted cost) — so per-task ctx fields and run-scoped ones are handled oppositely there.

See [[project_structured_verify_gates]] (same pre-task-verify leaf, sibling WS) and the T13 fresh-setup skip:
gated on `!carriedGreenForThisCwd` so it only fires for the FIRST task of a run (tasks 2..N use the existing
carry-baseline short-circuit). Settings key `harness.skipPreVerifyOnFreshSetup` default false; the schema's
`.default(false)` self-heals legacy files (no migration needed — same as escalateOnPlateau/escalationMap).
