---
name: eventbus-branch-listener-leak
description: Root-cause heap-leak fix — uncapped EventBus + discarded parallel-branch unsubscribes + retained SessionRecord runner ctx; the 5 seams that pin the long-session OOM
metadata:
  type: project
---

The long parallel-implement OOM (~3GB→~7GB over 3h) is a listener/retainer leak, NOT a cap problem.

**Why:** dominant retainer chain is `EventBus.handlers` Set → leaked per-branch bridge closure →
branch `Runner` → forked `ImplementCtx` (worktree paths + task list + accumulators) + 5000-entry trace
ring. Branches that never deliver a clean terminal (rate-limit drain, fatal-sibling kill race, mid-wave
abort) leave their bridge + durable-fold subscriptions on the process-wide bus forever. The heap-critical
83% handler could not reach these (it only cleared small-capped buffers), so the warning drained nothing.

**How to apply — the 5 seams (all touched in the oom-hardening fix):**

- `integration/observability/in-memory-event-bus.ts` — `handlers` Set was uncapped/strong-ref. Now warns
  ONCE via console.warn at `LISTENER_LEAK_THRESHOLD = 300` (steady state is <50: log-forwarder +
  notification-subscriber + a few UI hooks + ≤5 auto-detaching branch bridges + prologue/epilogue/distill
  sub-runners). Cap is a forcing-function, NOT a functional limit — never drops events.
- `application/flows/implement/parallel-element.ts` — PRIMARY fix: `onBranchRunner` captured BOTH unsubs
  (bridge + `captureDurableFold`, which now RETURNS its unsub) into a per-wave `branchUnsubs` Set, force-
  detached in a `try/finally` around `runWaves`. `runSubElement` (prologue/epilogue) previously DISCARDED
  the bridge unsub at line ~218 — now captured + force-detached in finally. Detach is idempotent.
- `application/chain/run/wave-scheduler.ts` `assemble()` — null `runs[i]` AFTER extracting trace+outcome,
  so each settled branch runner is GC-eligible the moment its wave drains (not at end of whole runWaves).
- `application/ui/tui/runtime/session-manager.ts` — on terminal, `update()` swaps `record.runner` for a
  `terminalRunnerStub` (keeps id/status/trace, drops live ctx — nothing reads runner.ctx post-terminal).
  Added `SESSION_RUNNING_CEILING = 200` emergency tier in `evict` (sheds oldest RUNNING records; bounds
  map at ceiling+1 since evict is pre-insert/on-terminal only) + `shedTerminal()` for the heap handler.
- `application/ui/tui/launch.ts` — `sessions` now created BEFORE the heap watchdog; the critical handler
  calls `sessions.shedTerminal()` (the real reachable weight) before the snapshot.

**Gotchas:** `runner.trace` is always the SAME array instance (never reassigned) → the `'step'` update
was spreading a fresh descriptor for a no-op trace ref change, invalidating the execute view's
`useBucketedTasks` memo (keyed on descriptor ref) → per-step `bucketTaskSignals` re-run = the
DEBUG-floor commit amplifier. Fix #6: `'step'` now calls `touchTrace(id)` (notify only, no descriptor
rebuild); live rail stays current via chainEvents + shared-mutable trace, per the sigOf comment in
sessions-context.tsx. `dev`/`start` already carry `--max-old-space-size=8192` (guardrail #7, pre-existing).
See [[project_chain_runner_containment_boundary]], [[project_tui_commit_storm_coalescer]],
[[project_wave_scheduler_above_chain]].
