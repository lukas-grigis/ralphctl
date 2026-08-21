---
name: seams_chain_runner_core
description: createRunner as the chain's only containment boundary, the aborted-with-error event contract, and the five seams that pin the long-session listener leak
metadata:
  type: project
---

Files: `application/chain/run/runner.ts`, `application/chain/build/leaf.ts`,
`integration/observability/in-memory-event-bus.ts`, `flows/implement/parallel-element.ts`,
`chain/run/wave-scheduler.ts`, `ui/tui/runtime/session-manager.ts`, `ui/tui/launch.ts`.

## createRunner is the SINGLE containment boundary

`createRunner.run()` wraps `element.execute()` in try/catch — nothing else in the chain does.

**Why it has to:** `leaf` deliberately re-propagates a non-DomainError throw from a ctx projection
(`if (!isDomainError(cause)) throw cause`), and no composite primitive (sequential/loop/guard) catches
it. The TUI fires `void result.runner.start()` fire-and-forget, so an uncaught throw becomes an
unhandled rejection that on Node 24 kills the process mid-alt-screen, leaving the runner stuck in
`running` with no terminal event — and it falsifies the wave scheduler's documented "start() never
rejects" invariant.

**`isDomainError` is exact membership in `Object.values(ErrorCode)`**, held in a `Set<unknown>`
(`Array.includes()` rejects an `unknown` arg because `ErrorCode` is an `as const` object, not a TS
enum). It used to accept any `Error` with a _string_ `code`, which matched every Node errno error
(EACCES/ELOOP/ENOENT) and laundered adapter I/O failures into the domain channel with a bogus code.
**Accepted trade-off:** an errno throw now emits NO trace entry and unwinds at the runner, so the TUI
rail names the ROOT element instead of the failing leaf — the same shape a `TypeError` throw already
had. Do not "fix" it by loosening the predicate.

**On catch:** synthesize an `InvalidStateError` carrying the cause's message + stack as a hint, set
`status='failed'`, emit `failed`. **CRITICAL:** a raw-thrown `AbortError` (code `ErrorCode.Aborted`)
must travel the abort path instead (`status='aborted'`, emit `aborted`) — same as the existing
`result.error.error.code === 'aborted'` branch. Do NOT add a sixth chain primitive or a `retry` /
`onError` for this; it is a runner concern.

## `aborted` events carry an error only for IN-CHAIN aborts

`RunnerEvent` has two abort kinds that used to be indistinguishable: the caller killed the run
(`abort()` / outer signal / fatal-sibling kill), or the CHAIN ITSELF settled with an `aborted`-coded
error. The runner emits `{ type: 'aborted', error }` for the second kind only, via the
`settleAborted(error?)` helper — `abortRequested` gates the field off, and `abortError` is retained so
late-subscriber replay stays lossless.

**Why the distinction is load-bearing:** `createRunner` routes ANY `aborted`-coded error to the
`aborted` terminal and never emits `failed`, so the wave scheduler's `capturedError` (fed only from
`failed`) stayed `null` for a branch whose own chain aborted. `classify` early-returned,
`stopLaunching` stayed false, `runWaves` returned `Result.ok` — so an operator answering "abort" at an
in-branch prompt (red-baseline gate, preflight-task, post-task-verify, or any `InkInteractivePrompt`
cancel, all of which build an AbortError with the outer signal untouched) was silently downgraded to
"this one task did not settle" while later waves kept spending generator/evaluator sessions.

**How to apply:** any new above-the-chain orchestrator reading runner terminals must capture
`event.error` on BOTH `failed` and `aborted`. An aborted event WITHOUT an error means "I killed this
branch" — ignoring it there is what keeps fatal-sibling / outer-signal kills from double-reporting
(first-fatal-wins still keeps a RateLimitError ahead of the synthesized abort). Do NOT synthesize
`new AbortError({ elementName: branch.id })` in the scheduler instead — that loses the operator's
reason string, which is what the TUI rail and `chain.log` display.

## The long-session OOM is a listener/retainer leak, not a cap problem

Dominant retainer chain: `EventBus.handlers` Set → leaked per-branch bridge closure → branch `Runner` →
forked `ImplementCtx` (worktree paths + task list + accumulators) + the trace ring. Branches that never
deliver a clean terminal (rate-limit drain, fatal-sibling kill race, mid-wave abort) leave their bridge
and durable-fold subscriptions on the process-wide bus forever. The heap-critical handler could not
reach any of it — it only cleared small-capped buffers — so the warning drained nothing.

Five seams pin it:

1. **`in-memory-event-bus.ts`** — the `handlers` Set was uncapped and strong-ref. It now warns ONCE via
   `console.warn` at `LISTENER_LEAK_THRESHOLD` (150; steady state is well under it — log-forwarder,
   notification-subscriber, a few UI hooks, the auto-detaching branch bridges, prologue/epilogue/distill
   sub-runners). The cap is a forcing function, NOT a functional limit — it never drops events.
2. **`parallel-element.ts`** — the PRIMARY fix. `onBranchRunner` captures BOTH unsubs (the bridge and
   `captureDurableFold`, which now RETURNS its unsub) into a per-wave `branchUnsubs` Set, force-detached
   in a `try/finally` around `runWaves`. `runSubElement` (prologue/epilogue) previously DISCARDED its
   bridge unsub — now captured and force-detached in `finally`. Detach is idempotent.
3. **`wave-scheduler.ts` `assemble()`** — nulls `runs[i]` AFTER extracting trace + outcome, so each
   settled branch runner is GC-eligible the moment its wave drains, not at the end of `runWaves`.
4. **`session-manager.ts`** — on terminal, `update()` swaps `record.runner` for a `terminalRunnerStub`
   (keeps id/status/trace, drops the live ctx — nothing reads `runner.ctx` post-terminal). Plus a
   `SESSION_RUNNING_CEILING = 200` emergency tier in `evict` (sheds the oldest RUNNING records) and
   `shedTerminal()` for the heap handler.
5. **`launch.ts`** — `sessions` is created BEFORE the heap watchdog so the critical handler can call
   `sessions.shedTerminal()` (the real reachable weight) before taking the snapshot.

**Gotcha worth keeping:** `runner.trace` is always the SAME array instance (never reassigned), so the
`'step'` update was spreading a fresh descriptor for a no-op trace-ref change, invalidating the execute
view's `useBucketedTasks` memo (keyed on descriptor ref) and re-running `bucketTaskSignals` per step —
the commit amplifier. `'step'` now calls `touchTrace(id)` (notify only, no descriptor rebuild); the live
rail stays current via chainEvents + the shared-mutable trace.

Related: [[seams_parallel_runner_architecture]], [[seams_tui_architecture_patterns]],
[[seams_memory_ledger_and_mutex]].
