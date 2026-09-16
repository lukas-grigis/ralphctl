---
name: seams-implement-prologue-gates
description: The implement prologue's dirty-tree gate — why it asks instead of aborting, where it sits relative to setup, and the scripted-git call counters in e2e tests that silently encode its call count
metadata:
  type: project
---

The implement prologue has exactly ONE dirty-tree gate: `sequential('preflight-tasks', …)` (the
interactive keep / stash / reset / cancel menu), placed directly after `resolve-branch` and BEFORE
`progress-journal-activate` / `setup-script-runner`.

**Why:** there used to be a second, stricter `working-tree-clean-check` hard gate ahead of setup
that aborted the launch outright and exempted only the "resume" signature (an `in_progress` task
whose last attempt is still `running`). Dirt outside that narrow signature — a cancelled run, or a
task an operator unblocked, since `unblockTask` archives the very attempts the signature keyed on —
killed the launch before the recovery menu ever fired. Removed 2026-09-16. The placement before
setup preserves the "answer once, then walk away" property: branch + dirty tree are the only two
questions a run asks, both up front, and the multi-minute setup script then runs against a tree the
operator already settled.

**How to apply:** do not re-add a pre-setup hard abort for a dirty tree — a dirty tree always asks.
If you change the number of `status --porcelain` calls the prologue makes, four e2e scripted
`GitRunner` fakes encode that count as a `preflightStatusesRemaining` countdown before they flip
into their per-task "dirty window" (`tests/e2e/flows/implement.test.ts` ×2,
`tests/e2e/full-stack/implement-review-close.test.ts`, `tests/e2e/full-stack/sprint-lifecycle.test.ts`).
Getting it wrong does not fail loudly at the gate — it shifts the dirty/clean window and the
failure surfaces later, in `settle-attempt`'s worktree-clean guardrail or `commit-task`. Grep
`preflightStatusesRemaining` before touching prologue git calls. The flow topology fence is
`tests/unit/application/flows/implement/flow-shape.test.ts`, which rebuilds the expected
`implement-locked` child list by hand. See [[seams_chain_runner_core]].
