---
name: wave-scheduler-above-chain
description: runWaves is an above-the-chain orchestrator (NOT an Element) driving N per-branch createRunner instances; the first real ALS fan-out consumer
metadata:
  type: project
---

`src/application/chain/run/wave-scheduler.ts` (`runWaves<TCtx>`) is the parallel-implement execution core.

**Why:** Implements "Approach C" — an above-the-chain async orchestrator. Per §14 it adds ZERO chain primitives: it deliberately does NOT implement the `Element` interface and must never be `.children`-walked or composed into a `sequential`/`loop`. It sits ABOVE the five primitives, sequencing whole sub-chains.

**How to apply (for T8/T9a/T9b and any future caller):**

- It is GENERIC — imports nothing flow-specific. The caller injects `config.merge(base, outcomes) => TCtx` (T8's `mergeImplementWave` is the implement reducer) and `config.onBranchRunner(runner, branch)` to bridge each branch runner to the EventBus (`bridgeRunnerToEventBus`, `chainId = task-<id>`).
- Each branch runs on its OWN `createRunner({ id: branch.id, … })`. The runner already wraps `element.execute` in `runWithSession(id, …)` internally — so passing `branch.id` as the runner id IS the per-branch ALS session scope. This is the first real ALS fan-out consumer; don't re-wrap in another `runWithSession`.
- Pool bound: a `Set<Promise<BranchRun>>` + `Promise.race` drain, cap re-clamped to `[1,5]` (`MAX_CONCURRENCY_CEILING=5`, mirrors the settings clamp). Waves are STRICTLY sequential — wave k+1 awaits all of k settling AND `merge` folding.
- Combined trace is assembled in branch-DECLARATION order (per-index slots), never completion order.
- Abort: outer-signal abort forwards `runner.abort()` to every branch, awaits all settle (cleanup runs), returns `Result.error({error: AbortError, trace})` VERBATIM — never folded into a branch outcome. `aborted` always kills immediately.
- Rate-limit: `config.onFatal: 'kill' | 'drain'` (default `'drain'`). `'drain'` lets in-flight siblings finish then stops launching the rest of the wave; `'kill'` aborts siblings now. Fatal classification reuses `isRecoverableTurnError` (`business/task/turn-error-policy.ts`): `aborted`/`rate-limit` are fatal, everything else absorbed into the branch's `BranchOutcome`.
- Exports tagged `@public` (knip whitelist) since the real caller lands in T9b. See [[project_recoverable_turn_error_policy.md]] for the related per-task block policy.
