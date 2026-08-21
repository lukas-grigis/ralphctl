---
name: seams_parallel_runner_architecture
description: Above-the-chain and nested-runner architecture — runWaves, the sub-chain adapter pattern, rootSessionId vs currentSessionId, and the ALS import fence
metadata:
  type: project
---

Files: `application/chain/run/wave-scheduler.ts`, `application/flows/_shared/memory/distill-step.ts`,
`application/session/session.ts`.

## `runWaves` is an above-the-chain orchestrator, NOT an Element

`wave-scheduler.ts`'s `runWaves<TCtx>` is the parallel-implement execution core. It adds ZERO chain
primitives: it deliberately does not implement `Element`, and **must never be `.children`-walked or
composed into a `sequential`/`loop`.** It sits ABOVE the five primitives, sequencing whole sub-chains.

- **Generic** — it imports nothing flow-specific. The caller injects `config.merge(base, outcomes) =>
TCtx` (the implement reducer is `mergeImplementWave`) and `config.onBranchRunner(runner, branch)` to
  bridge each branch runner to the EventBus (`bridgeRunnerToEventBus`, `chainId = task-<id>`).
- **Each branch runs on its OWN `createRunner({ id: branch.id, … })`.** The runner already wraps
  `element.execute` in `runWithSession(id, …)`, so **passing `branch.id` as the runner id IS the
  per-branch ALS session scope — do not re-wrap in another `runWithSession`.**
- **Pool bound:** a `Set<Promise<BranchRun>>` + `Promise.race` drain, cap re-clamped to `[1, 5]`
  (`MAX_CONCURRENCY_CEILING = 5`, mirroring the settings clamp). Waves are STRICTLY sequential — wave
  k+1 awaits every branch of k settling AND `merge` folding.
- **Combined trace is assembled in branch-DECLARATION order** (per-index slots), never completion order.
- **Abort:** an outer-signal abort forwards `runner.abort()` to every branch, awaits all settles (so
  cleanup runs), and returns `Result.error({error: AbortError, trace})` VERBATIM — never folded into a
  branch outcome. `aborted` always kills immediately.
- **Rate limit:** `config.onFatal: 'kill' | 'drain'` (default `'drain'`). `'drain'` lets in-flight
  siblings finish then stops launching the rest of the wave; `'kill'` aborts siblings now. Fatal
  classification reuses `isRecoverableTurnError` — `aborted`/`rate-limit` are fatal, everything else is
  absorbed into the branch's `BranchOutcome`.

## Reusing a sub-chain across hosts: a nested-runner ADAPTER, not a sixth primitive

To compose a self-contained sub-chain (its own ctx + leaves) into multiple host flows WITHOUT widening
each host ctx with the sub-chain's shape, write a thin `Element<TCtx>` adapter that maps host ctx → a
fresh sub-ctx and runs the sub-chain through a NESTED `createRunner`, forwarding the same `AbortSignal`.
A nested runner inside an element is an adapter, not a new primitive. This is what lets close-sprint AND
review reuse one `createDistillLearningsSubChain` while their ctxs gain only a `distillRequested: boolean`
flag (see `_shared/memory/distill-step.ts`).

- The adapter is a factory `(deps, opts, name?) => Element<TCtx>` where `opts` carries everything static
  the sub-chain needs that does NOT vary by host ctx (projectId, roots, repository, AI settings); the
  host ctx contributes only the gate flag. Place it next to the sub-chain in `_shared/`.
- **Forward abort:** `signal?.addEventListener('abort', () => runner.abort(), { once: true })`, removed
  in `finally`. The nested runner's own `AbortController` is the bridge target.
- **Capture sub-trace via `runner.subscribe` BEFORE `start()`** (so `step` events are live) and re-emit
  through the host `onTrace`, so the TUI rail and chain.log see sub-steps inline.
- **Error mapping uses `runner.status`:** `aborted` → `Result.error(AbortError)` (transparent
  propagation; the host `sequential` then skips the rest, leaving the sprint re-runnable). Since the
  runner routes any `Aborted`-coded error to `aborted`, a `failed` status is structurally
  AbortError-exempt — that is where best-effort fallback (warn + `Result.ok`) lives.
- **Wire it in as a spread-conditional element:** `...(deps.distill !== undefined ? [step] : [])`, so
  the step is omitted entirely when its optional deps bag is absent.
- Per-provider interactive AI: `interactiveAiFor: (provider) => InteractiveAiProvider` lives on
  `AppDeps` (wired in `wire.ts`); launchers assemble the sub-chain deps from it plus launcher-level
  `runInTerminal` (Ink-aware, cannot live in `wire()`).

## `rootSessionId()` vs `currentSessionId()`

`session.ts` stores `{ sessionId, rootSessionId }`. `runWithSession` SHADOWS `sessionId` (innermost
wins — per-branch logger / signal attribution needs that) but INHERITS `rootSessionId` from the
enclosing scope.

**Why it exists:** the parallel path runs one `createRunner({ id: 'task-<taskId>' })` per task inside
the host runner's scope (plus prologue/epilogue sub-runners), and the runner wraps every
`element.execute()` in `runWithSession(opts.id, …)`. So every generator/evaluator spawn stamped
`chainSessionId` with `task-<uuid>`, while the Execute view reads `useTokenUsage(bus).get(hostRunnerId)`
— the token/context readout was blank for the whole run on any `maxParallelTasks > 1` sprint. Threading
the host id as data would have meant six-plus layers; the ALS root fixes every stamper at once, and
future nested runners for free.

**The rule: anything keyed by BRANCH (logs, per-task signals) keeps `currentSessionId()`; anything keyed
by SESSION as the TUI sees it uses `rootSessionId()`.** The converted `chainSessionId` stampers are
`implement/leaves/{implement-session,reproduce,best-of-n-candidate,best-of-n-selection}.ts` and
`_shared/signals-session.ts`. `review-round.ts` and `create-pr/leaves/generate-pr-content-leaf.ts` still
read `currentSessionId()` — correct today (single runner, root === current) — but convert them if either
flow ever nests.

## The ALS helper is lint-fenced out of integration

`currentSessionId()` / `runWithSession()` live in `src/application/session/session.ts`. The integration
fence in `eslint.config.ts` bans `**/application/**` imports from `src/integration/**`, and it applies to
provider files too: the per-provider sibling-isolation block sets `siblingIsolationRule`, but the later
integration block re-applies the application ban, and last-matching flat-config wins per rule. Verified
empirically — importing it into a provider `headless.ts` produces "Layer dependency violation".

**So no integration adapter reads the ALS session id today.** The only consumer is `runner.ts`. Any doc
claiming "deep adapters read `currentSessionId()` and tag logs/signals" describes an aspiration.

`node:async_hooks` is NOT in the `nodeIoBans` list, so the helper is pure enough to live in
`business/observability/`; it sits in `application/` for historical reasons only. **Any task needing an
integration adapter (provider headless, signal sink) to read the chain runner id must FIRST relocate the
helper** to `business/observability/session.ts` (or domain) and update the `runner.ts` /
`wave-scheduler.ts` / `parallel-element.ts` imports — the import is a hard lint error otherwise. Note
the provider uuid `sessionId` is a DIFFERENT id space from the runner id
(see [[seams_provider_engine_streaming]]).

## Two sibling TUI-runtime facts from the same work

- **`RouterApi.reset(entry)` no longer accepts a bare call.** The old optional form fell back to the
  FROZEN `initial` prop, so `h` / `D` on a first-run session re-mounted `welcome` / `create-project`.
  WelcomeView's seed is now gated on `settingsRepo.exists()` (disk-backed), not just its per-instance
  `useRef` — a re-mount used to re-run `applyPreset`, which replaces the whole `ai` section over the
  user's Settings edits. Test gotcha: the settings-apply-preset FLOW itself calls
  `detectInstalledProviders()`, so a seeding run counts 2 detect calls, not 1.
- **`guard` emits exactly ONE synthetic `skipped` trace entry, named after its BODY element.** For a
  dependency-blocked task that means only `dependency-gate-<id>` (completed) + `task-body-<id>`
  (skipped) — no failed/aborted entry, no terminal leaf — so `resolveStatusFromSubSteps` returned
  `running` forever and pinned the header/card cursor. Fixed by a `task-body`-named skipped check
  (`BucketOptions.bodySubstepName`), NOT by "any skipped substep", because `reproduce-guard` /
  `quarantine-blocked-diff-guard` skip routinely inside a healthy task. Cursor scans share
  `isInFlightBucket` (running|pending); `tasksDone` still counts only `completed` on purpose, so a
  blocked task keeps `2/3` non-green.

Related: [[seams_chain_runner_core]], [[seams_attempt_ctx_and_telemetry]].
