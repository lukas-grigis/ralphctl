---
name: runner-aborted-event-error-seam
description: RunnerEvent 'aborted' carries an optional error ONLY for in-chain aborts (not caller abort()); wave-scheduler keys on it to stop the schedule
metadata:
  type: project
---

`RunnerEvent` (src/application/chain/run/runner.ts) has TWO kinds of abort that used to be
indistinguishable to any subscriber: the caller killed the run (`abort()` / outer signal /
fatal-sibling kill), or the CHAIN ITSELF settled with an `aborted`-coded error. The runner now
emits `{ type: 'aborted', error }` for the second kind only (via the `settleAborted(error?)` helper;
`abortRequested` gates the field off, and `abortError` is retained so late-subscriber replay is
lossless).

**Why:** `createRunner` routes ANY `aborted`-coded error to the `aborted` terminal and never emits
`failed`, so the wave scheduler's `capturedError` (only fed from `failed`) stayed `null` for a
branch whose own chain aborted. `classify` early-returned, `stopLaunching` stayed false, and
`runWaves` returned `Result.ok` — so an operator answering "abort" at an in-branch prompt
(verify-execution red-baseline gate, preflight-task, post-task-verify, or any
`InkInteractivePrompt` cancel, all of which build an AbortError with the outer signal untouched)
was silently downgraded to "this one task did not settle" while later waves kept spending
generator/evaluator sessions. Fixed 2026-08-18 in the maintenance-hardening batch.

**How to apply:** Any new above-the-chain orchestrator that reads runner terminals must capture
`event.error` on BOTH `failed` and `aborted` — an aborted event WITHOUT an error means "I killed
this branch", so ignoring it there is what keeps fatal-sibling / outer-signal kills from
double-reporting (first-fatal-wins still keeps a RateLimitError ahead of the synthesized abort).
Do NOT synthesize `new AbortError({ elementName: branch.id })` in the scheduler instead — that
loses the operator's reason string, which is what the TUI rail and `chain.log` display. See
[[chain-runner-containment-boundary]] for the adjacent raw-throw abort path (it now forwards the
thrown AbortError through the same helper).
