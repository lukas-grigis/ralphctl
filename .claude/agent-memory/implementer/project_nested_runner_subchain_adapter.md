---
name: nested-runner-subchain-adapter
description: Reusing a self-contained sub-chain across host flows via a nested-runner adapter element (NOT a 6th chain primitive)
metadata:
  type: project
---

To compose a self-contained sub-chain (its own ctx + leaves) into multiple host flows WITHOUT widening
each host ctx with the sub-chain's full shape, write a thin `Element<TCtx>` adapter that maps host ctx →
fresh sub-ctx and runs the sub-chain through a NESTED `createRunner` (same `AbortSignal` forwarded).

**Why:** A nested runner inside an element is NOT a sixth chain primitive — it's an adapter, not a new
primitive. It lets close-sprint AND review reuse one `createDistillLearningsSubChain` while their ctxs only
gain a single `distillRequested: boolean` flag (the sub-chain carries `entries`/`candidates`/`acceptedIds`
internally). See `src/application/flows/_shared/memory/distill-step.ts` (`createDistillStep`).

**How to apply:**

- Adapter is a factory `(deps, opts, name?) => Element<TCtx>` where `opts` carries everything static the
  sub-chain needs that does NOT vary by host ctx (projectId, roots, repository, AI settings); the host ctx
  contributes only the gate flag. Place it next to the sub-chain in `_shared/`.
- Forward abort: `signal?.addEventListener('abort', () => runner.abort(), { once: true })`, removed in
  `finally`. The nested runner's own `AbortController` is the bridge target.
- Capture sub-trace via `runner.subscribe` (subscribe BEFORE `start()` → live `step` events) and re-emit
  through the host `onTrace` so TUI rail + chain.log see sub-steps inline.
- Error mapping uses `runner.status`: `aborted` → return `Result.error(AbortError)` (transparent
  propagation; the host `sequential` then skips the rest — leaves the sprint re-runnable). The runner routes
  any `Aborted`-coded error to `aborted`, so a `failed` status is structurally AbortError-exempt — that's
  where best-effort fallback (warn + `Result.ok`) lives.
- Wire it into the flow as a spread-conditional element: `...(deps.distill !== undefined ? [step] : [])` so
  the step is omitted entirely when its optional deps bag is absent.
- Per-provider interactive AI: `interactiveAiFor: (provider) => InteractiveAiProvider` lives on `AppDeps`
  (wired in `wire.ts` via `createInteractiveAiProviderFor`); launchers assemble the sub-chain deps from it
  plus launcher-level `runInTerminal` (Ink-aware, can't live in `wire()`). See related
  [[project_chain_deps_reachability_fence]].
