---
name: launcher-hitl-distill-confirm
description: Test patterns for launchCloseSprint/launchReview HITL distill confirm gate — LaunchContext stubbing, identityBridge, scriptedConfirm
metadata:
  type: feedback
---

`tests/unit/application/ui/shared/launch/distill-confirm-abort.test.ts` — 10 tests covering
`launchCloseSprint` and `launchReview`:

- `abort` (AbortError) on distill confirm → `{ ok: false, reason: 'Cancelled.' }` (load-bearing:
  fails if the guard is removed)
- `Result.ok(false)` on distill confirm → runner returned (no cancel; distillRequested: false)
- `Result.ok(true)` on distill confirm → runner returned (distillRequested: true)
- close-sprint: first close confirm aborted → Cancelled
- no sprint selected / no project loaded → early failure from each launcher

**Key patterns:**

- `LaunchContext` stub: partial `AppDeps` cast `as never` for fields the launch path never reaches
  before the guard
- `identityBridge = <T>(r: Runner<T>) => r` — no event bus needed for launcher unit tests
- `makeSnapshot({ omitSprint: true })` / `makeSnapshot({ omitProject: true })` —
  `exactOptionalPropertyTypes` forbids `{ sprint: undefined }` in a `Partial<AppStateSnapshot>`
  spread; use named boolean flags instead
- `scriptedConfirm` builds the prompt fake as an array of response factories (zero-arg functions);
  `void input` suppresses unused-var lint
