---
name: seams-implement-prologue-gates
description: The implement prologue's dirty-tree gates (pre-setup menu, in-leaf post-setup check, e2e scripted-git call counters) plus where restore-blocked-diff sits in the attempt and why
metadata:
  type: project
---

The implement prologue has exactly ONE up-front dirty-tree menu: `sequential('preflight-tasks', …)` (the
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

**Setup-created dirt has its own check, and it lives INSIDE `setup-script-runner`.** It's an
injected `treeGuard` (`leaves/setup-tree-guard.ts`), not a separate step, so the element list is
unchanged. It takes a porcelain snapshot right before each script that actually spawns, then
compares after a green exit, and re-offers the menu only for lines the script ADDED. A resume-skipped
or unconfigured script makes zero git calls, which is why the e2e counters above are unaffected: none
of them configures a `setupScript`. A repo whose setup dirtied the tree is left out of
`setupVerifiedRepoIdsThisRun`, because a stash or reset would otherwise let
`skipPreVerifyOnFreshSetup` seed a green baseline for a tree setup never verified. The wiring fence
runs the real `buildImplementPrologue`
(`tests/integration/application/flows/implement/prologue-post-setup-tree-check.test.ts`), because
the guard dep is optional on the leaf and the shape fence can't see deps.

**A dirty tree at attempt start is a normal state, not an anomaly.** The sources are the operator
choosing "keep", the per-task reproduce leaf (FULL_AUTO, writes a new test BEFORE the attempt loop
on both paths for bugfix tasks, except on a relaunch with a quarantined stash), and setup output
that isn't ignored. `restore-blocked-diff` only
pops onto a tree it probed clean, because its undo is `reset --hard` + `clean -fd`. A failed
`git stash pop` can still have changed the tree (verified on git 2.54): an untracked collision
applies the tracked part first, and an "overwritten" refusal still restores untracked files. So
"no unmerged paths" does NOT mean "tree unchanged". The probe keeps `--ignore-submodules=none` on top
of what `gitStatusPorcelain` passes (that one already forces `--untracked-files=normal`).

**Restore order is load-bearing: `start-attempt → pre-task-verify → guard(restoreBeforeFirstTurn,
restore-blocked-diff) → gen-eval`.** A successful pop DROPS the stash entry. Restoring before
pre-verify (the old order) lost the diff on a pre-verify block (zero turns → `isSettledBlocked`
false → no re-quarantine → parallel worktree force-removed) and let a red restored diff make the
baseline red, so the red post read `baseline-broken` and committed under the `proceed` amnesty. The
guard is `ctx.lastExit === undefined`, i.e. "a generator turn is guaranteed to follow". Proposals to
restore "once, ahead of reproduce" re-open both bugs — keep restore after pre-verify.
**Why:** real-git repros, 2026-09-17. **How to apply:** the parallel teardown also needs a
branch-start stash snapshot (`snapshotQuarantinedDiff`, taken before `worktree add`) so an
interrupted in_progress attempt whose LAST attempt has no commit re-stashes the popped diff before
`worktree remove`; any reshape of `withWorktree` must keep that snapshot and the `quarantinedAtStart`
teardown arg. It is a COUNT of entries under the task key, not a boolean: a key can hold several
entries (a failed pop keeps one, the next block pushes another), the pop takes the newest, so "an
entry is still listed" proves nothing. Compare counts (fewer now → re-stash). The count is exact only
because nothing else pushes under that key mid-branch on the parallel path — adding an in-branch push
under `quarantineStashMessage` would break it. The serial-path abort-after-pop case is still open
(diff only in the shared tree).

**A bugfix relaunch is solved in the reproduce leaf, not by moving the restore.** The reproduce
leaf lists the stash first. When the task's quarantine entry is there, it never spawns and never
writes into the tree: it adopts `<sprintDir>/implement/<id>/reproduce/artifact.json` (saved after
every accepted spawn, deleted before every fresh spawn), or continues with no reproduction. The
restore then re-checksums the test (listed stash only). A mismatch KEEPS `ctx.reproductionArtifact`
only when the pop restored a change to that path (a prior launch's edit — the evaluator's tamper note
must fire); it drops it when the file is missing or is the committed copy (pop skipped/undone, or the
popped entry never touched it — the reproducer prefers appending a case to an existing test file, so
"present but different" is often just HEAD). **Why:** a fresh spawn dirtied the tree, so the
clean-tree-only restore never popped the earlier work. **How to apply:** any fake `GitRunner` that drives a defect-shaped
task ("fix"/"bug"/"crash" in the name) must answer `stash list` BEFORE `start-attempt`. Still open:
`quarantine-retry-diff` stashes the whole tree, reproduction test included, on a red-verify retry.

**Parallel worktree setup output is discarded at setup time, not excluded at commit time.** That was
a user decision on 2026-09-17. A commit-time path exclusion would also drop the task's own change to
the same path, like a lockfile when the task adds a dependency, and it would leave the worktree dirty
after the commit. The cost is that a build needing that output goes red in the worktree, so the
discard is logged at warn with the remedy. The `SetupTreeRecord` is lossless: past the 200 cap,
`recordSetupTree` collapses paths into `/`-terminated directories (deepest first, then largest
first). It only truncates past 200 top-level entries, and a truncated record is never resumed from.
Only the repo's latest setup row gates the resume. A `'skipped'` no-script row doesn't count because
nothing ran, so it behaves like a resume-skip.
