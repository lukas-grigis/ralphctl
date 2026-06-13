---
name: generator-feedforward-seams
description: Two generator-prompt feed-forward injections (cross-sprint prior-learnings + per-attempt dimension-trajectory) and where they thread through ctx/prompt
metadata:
  type: project
---

Batch C (harness-gen-quality) added two feed-forward context injections to the implement generator
prompt. Both are PURE ctx reads in the generator leaf's input projection — no chain/contract changes.

**Why:** generators previously saw only the latest critique string; cross-sprint ledger learnings and
the multi-round failed-dimension trajectory were stranded in ctx and never reached the prompt
(principles 3, 6, 15).

**How to apply:**

- `composeDimensionTrajectory` (`business/task/dimension-trajectory.ts`) — diffs `ctx.plateauHistory`
  (last vs prior turn) into fixed / still-failing(N) / newly-failing lines + a budget-pressure line at
  `plateauThreshold-1`. Rides INSIDE `PRIOR_CRITIQUE_SECTION` (extended `renderPriorCritiqueSection` to
  take an optional 2nd `trajectory` arg) — NO new template placeholder. Threaded on BOTH the full
  implement and continuation prompts. Generator leaf needs `deps.plateauThreshold` (already in
  `sharedLeafDeps` from gen-eval-loop).
- `composePriorLearnings` (`application/flows/_shared/memory/compose-prior-learnings.ts`) — caps to 15
  most-recent unpromoted ledger records, Insight + appliesTo only. NEW `{{PRIOR_LEARNINGS}}` placeholder
  (renderer `renderPriorLearningsSection` in renderers/task.ts). Loaded ONCE in the implement prologue
  via `loadLearningsLeaf` → `ctx.priorLearnings` (run-scoped field). Rides ONLY the full prompt, NOT the
  continuation (resumed thread already has it). Distill flow / human gate untouched.

`ctx.priorLearnings` is a run-scoped field — same 3-fence treatment as [[project_run_scoped_ctx_marker_fences]]:
classified SPRINT in merge-wave `_exhaustive`, carried in `forkCtx` + `mergeImplementWave`. Adding the
`load-learnings` leaf to the prologue also required updating the flow-shape fence test's
`reconstructPreRefactorSerialFlow` (independent reconstruction, NOT factory-derived).
