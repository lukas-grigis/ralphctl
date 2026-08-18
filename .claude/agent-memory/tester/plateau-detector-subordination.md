---
name: plateau-detector-subordination
description: entropy-check / loop-diversity-check can never fire through the composed gen-eval loop — their firing unit tests are isolated-unit contracts only; fence tests pin the mutual exclusion
metadata:
  type: project
---

# The two bolt-on plateau detectors are unreachable in the composed loop

**Fact.** `loopDiversityCheckLeaf` and `entropyCheckLeaf` fire only when
`ctx.lastExit === undefined` AND `windowIsHardStall(window)`. `windowIsHardStall` is true exactly
when `classifyPlateauWindow` says `'stalled'` — which is exactly the case where
`computePlateauVerdict` returns `{kind:'plateau'}`, which `run-evaluator-turn` turns into an exit
that the evaluator leaf (one/two elements EARLIER in the same `gen-eval-turn` sequential) merges
onto `ctx.lastExit`. The two conditions are mutually exclusive by construction, so a
`source: 'entropy'` / `source: 'diversity'` exit is not reachable in production.

**Why it matters:** the unit tests' "firing" cases pin a ctx state the real loop never presents.
Left undocumented they read as behavioural guarantees. `settings.harness.entropyPlateauDetector`
is a user-facing knob with nil e2e effect, and `outcome-stats`' `bySource.diversity` /
`bySource.entropy` buckets are always zero. HARNESS-PRINCIPLES §6 lists both leaves as
removal-with-measurement candidates.

**How to apply:**

- Fences that lock this (do not weaken them):
  - `tests/unit/.../entropy-check.test.ts` and `loop-diversity-check.test.ts` each end with a
    `— subordination to the calibrated predicate` describe: for the file's own stalled-window
    fixture it asserts `windowIsHardStall(window) === true` AND
    `computePlateauVerdict(window.slice(0,-1), current).kind === 'plateau'`, plus a no-op case
    fed the ctx the loop really hands over (`lastExit: {kind:'plateau', source:'threshold'}`).
  - `tests/integration/application/flows/implement/leaves/gen-eval-loop.test.ts` →
    "attributes a genuine stall to the calibrated 'threshold' detector, not to a bolt-on".
- If someone proposes deleting the leaves, the knob and the two `bySource` buckets go with them.
  That is a production decision, not a test-side one.

Related: [[gen-eval-turn-step-order-fence]], [[gen-eval-exit-mapping]].
