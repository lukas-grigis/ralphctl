---
name: execute-view terminal state pattern
description: How the execute view tracks runner terminal status and renders completion CTA
type: project
---

`descriptor.status` is kept live by the SessionManager: `attachRunnerLifecycle` subscribes to `runner.subscribe(...)`
and calls `update(..., { status })` on `completed`/`failed`/`aborted`, transitioning the descriptor to its terminal
status (see `session-manager.ts`), then auto-detaches the listener now that the run is terminal. The execute view
therefore reads `descriptor.status` directly — `isRunning = descriptor?.status === 'running'` and
`<StatusChip label={descriptor.status} kind={runnerStatusKind(descriptor.status)} />` — and does NOT subscribe to
the runner or keep any local `runnerStatus` state.

Pattern in `execute-view.tsx` / `execute-view-internals/result-footer.tsx`:

- `execute-view.tsx`: `const isRunning = descriptor?.status === 'running'`
- `execute-view.tsx`: `<StatusChip label={descriptor.status} kind={runnerStatusKind(descriptor.status)} />`
- `result-footer.tsx`: renders the settled `ResultCard` keyed off `descriptor.status` (success/aborted/failed)

**Why:** SessionManager writes the terminal `status` + `finishedAt` into the descriptor itself (via `update(...)`
inside `attachRunnerLifecycle`'s `onCompleted`/`onFailed`/`onAborted` handlers), so views don't need their own
subscription to observe the terminal transition — reading `descriptor.status` is sufficient and live.

**How to apply:** Views that render runner lifecycle state read `descriptor.status` directly. Do not add a local
`runnerStatus` useState, an `effectiveStatusForHooks` derivation, or a view-level `runner.subscribe()` — that pattern
does not exist in the current code and there is no `nextStepsForFlow(...)` helper to hook into.
