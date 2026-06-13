---
name: chain-runner-containment-boundary
description: createRunner.run() wraps element.execute in try/catch — the chain's only containment boundary for non-DomainError throws; abort path must be preserved
metadata:
  type: project
---

`createRunner` (src/application/chain/run/runner.ts) `run()` wraps the `element.execute()` call in
try/catch and is the SINGLE containment boundary for programmer-error throws.

**Why:** `leaf` (chain/build/leaf.ts) deliberately re-propagates a non-DomainError throw from a ctx
projection (`if (!isDomainError(cause)) throw cause`), and no composite primitive (sequential/loop/
guard) catches it. The TUI fires `void result.runner.start()` (open-flow-session.ts) fire-and-forget,
so an un-caught throw becomes an unhandled rejection that on Node 24 kills the process mid-alt-screen
with the runner stuck in 'running' and no terminal event. It also falsifies the wave scheduler's
documented "start() never rejects" invariant.

**How to apply:** On catch, synthesize an `InvalidStateError` carrying cause message + stack (hint),
set status='failed', emit 'failed'. CRITICAL: a raw-thrown `AbortError` (code === ErrorCode.Aborted)
must travel the abort path (status='aborted', emit 'aborted') NOT the synthesized-failure path — same
as the existing `result.error.error.code === 'aborted'` branch. Don't add a 6th chain primitive or a
`retry`/`onError` for this — it's a runner concern. See [[recoverable-turn-error-policy]] for the
adjacent leaf-level recoverable-error routing.
