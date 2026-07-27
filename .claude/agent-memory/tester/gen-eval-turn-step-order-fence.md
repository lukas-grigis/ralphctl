---
name: gen-eval-turn-step-order-fence
description: gen-eval-loop.test.ts shape fence + crash-attribution — InvalidStateError is recoverable, only leaves emit trace entries
metadata:
  type: feedback
---

`tests/integration/application/flows/implement/leaves/gen-eval-loop.test.ts` — 4 tests:

- Loop-entry guard: refuses to enter when `ctx.lastExit` is already set.
- Shape fence: asserts gen-eval-turn children order = [resolve-round-num, stamp-meta-generator,
  stamp-role-meta-generator, generator-leaf, evaluator-guard] by name.
- Evaluator-guard body order: [stamp-meta-evaluator, stamp-role-meta-evaluator, evaluator-leaf].
- Crash-attribution: generator spawn fails (recoverable `InvalidStateError`) → loop returns ok with
  `lastExit.kind==='self-blocked'` AND `rounds/1/generator/meta.json` + `role-meta.json` exist on
  disk.

**Key gotcha**: `InvalidStateError` (code='invalid-state') is treated as RECOVERABLE by
`turn-error-policy.ts` — the generator error becomes a `self-blocked` exit, NOT a loop
`Result.error`. Use `createAtomicWriteFile()` for real file writes in behavioral tests.

**Sequential composites do NOT emit their own trace entry** — only leaves emit trace entries.
Assert leaf names in `runner.trace`, not composite names like 'implement' or 'review'.
