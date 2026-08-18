---
name: root-session-id-nested-runners
description: Nested runners shadow currentSessionId(); anything the TUI keys by SESSION (token-usage chainSessionId) must read rootSessionId() — plus the two other TUI-runtime seams fixed alongside it (router.reset explicit entry, guard-skipped task-body bucket status)
metadata:
  type: project
---

`src/application/session/session.ts` now stores `{ sessionId, rootSessionId }`. `runWithSession`
SHADOWS `sessionId` (innermost wins — per-branch logger / signal attribution needs that) but
INHERITS `rootSessionId` from the enclosing scope. `rootSessionId()` is the new export.

**Why:** the parallel implement path runs one `createRunner({ id: 'task-<taskId>' })` per task
inside the host runner's scope (plus prologue/epilogue sub-runners), and `runner.ts` wraps every
`element.execute()` in `runWithSession(opts.id, …)`. So every generator/evaluator spawn stamped
`chainSessionId` with `task-<uuid>`, while the Execute view does a plain
`useTokenUsage(bus).get(hostRunnerId)` — the token/context readout was blank for the whole run on
any `maxParallelTasks > 1` sprint. Threading the host id as data would have meant 6+ layers
(ParallelImplementConfig → buildWaveBranches → PerTaskSubchainOpts → attempt-body → gen-eval-loop
→ run-role-turn); the ALS root fixes every stamper at once and future nested runners for free.

**How to apply:** anything keyed by BRANCH (logs, per-task signals) keeps `currentSessionId()`;
anything keyed by SESSION as the TUI sees it uses `rootSessionId()`. The 5 `chainSessionId`
stampers converted: `implement/leaves/{implement-session,reproduce,best-of-n-candidate,
best-of-n-selection}.ts` + `_shared/signals-session.ts`. `review-round.ts` and
`create-pr/leaves/generate-pr-content-leaf.ts` still read `currentSessionId()` — correct today
(single runner, root === current), but convert them if either flow ever nests. Integration still
cannot import the helper at all — see [[session-als-fenced-from-integration]].

Two sibling TUI-runtime facts from the same batch:

- `RouterApi.reset(entry)` no longer accepts a bare call. The old optional form fell back to the
  FROZEN `initial` prop, so `h` / `D` on a first-run session re-mounted `welcome` /
  `create-project`. WelcomeView's seed is now gated on `settingsRepo.exists()` (disk-backed), not
  just its per-instance `useRef` — a re-mount used to re-run `applyPreset`, which replaces the
  whole `ai` section over the user's Settings edits. Gotcha for tests: the settings-apply-preset
  FLOW itself calls `detectInstalledProviders()`, so a seeding run counts 2 detect calls, not 1.
- `guard` emits exactly ONE synthetic `skipped` trace entry, named after its BODY element. For a
  dependency-blocked task that means only `dependency-gate-<id>` (completed) +
  `task-body-<id>` (skipped) — no failed/aborted entry, no terminal leaf — so
  `resolveStatusFromSubSteps` returned `running` forever and pinned the header/card cursor.
  Fixed by a `task-body`-named skipped check (`BucketOptions.bodySubstepName`, defaulted like
  `terminalSubstepName`) — NOT by "any skipped substep", because `reproduce-guard` /
  `quarantine-blocked-diff-guard` skip routinely inside a healthy task. The cursor scans now share
  `isInFlightBucket` (running|pending) from `bucket-task-signals.ts`; `tasksDone` still counts
  only `completed` on purpose (a blocked task is not a pass, so `2/3` stays non-green).
