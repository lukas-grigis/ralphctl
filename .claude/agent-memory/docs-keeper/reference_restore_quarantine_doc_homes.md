---
name: reference-restore-quarantine-doc-homes
description: Where restore-blocked-diff / quarantine / parallel-epilogue facts live across docs — three homes that must move together
metadata:
  type: reference
---

The implement flow's blocked-diff quarantine + restore mechanics, and the parallel epilogue's
fan-in/adopt-persisted-blocks contract, are documented in three places that must be edited together
whenever the ordering or the fan-in rules change:

1. **`WORKFLOWS.md` § "Blocked-diff quarantine & restore"** — the long prose walkthrough (stash
   message key, branch-ref keep/delete, restore ordering relative to `pre-task-verify`, the
   interrupted-parallel-branch re-stash). This is the deepest, most detailed home — start edits here.
2. **`ARCHITECTURE.md` § "Parallel task execution"** (inside `## Chain framework`, ~line 115) — the
   condensed architectural summary: `mergeImplementWave` / `ownedTask` disjointness,
   `adopt-persisted-blocks`, the per-worktree setup-tree check. Shorter, but every fact in it must
   agree with WORKFLOWS.md.
3. **`REQUIREMENTS.md` § "Implement flow"** — the `start-attempt → … → progress-journal` step-trace
   checkbox (attempt-body order) plus the "Blocked-task recovery is never silent" checkbox (fan-in /
   adopt-persisted-blocks guarantee). This is also one of the three canonical step-trace locations
   from [[reference_step_trace_locations]].

As of 2026-09-17 (resume-budget-overwrite / parallel-settled-restore-loss / bugfix-relaunch-restore /
parallel-setup-tree-check fixes): `restore-blocked-diff` moved from "first thing in the attempt body"
to "after `pre-task-verify`, guarded on no terminal exit yet" — this exact ordering sentence had to
change in all three homes plus `PERFORMANCE.md`'s parallel paragraph. `PERFORMANCE.md` § the parallel
scheduler paragraph is a fourth, lighter-weight home for the same facts (cost/throughput framing) —
check it too, though it tolerates more compression than the other three.

**Why they drift independently:** WORKFLOWS.md's paragraph is dense narrative prose that nobody
wants to fully reread on every implement-flow PR, so edits land in the code + REQUIREMENTS checkbox
first and WORKFLOWS.md rots. Treat a REQUIREMENTS.md attempt-body checkbox diff as a trigger to also
open WORKFLOWS.md's matching section, not just ARCHITECTURE.md.

**2026-09-17 follow-up review round** (findings 3/5/6/7/8/12/14 on the same batch, caught by a second
review pass after the first docs edit already landed): confirms the drift is real even WITHIN one
sitting — the first pass got the reordering right but missed that `worktree-teardown.ts`'s Ctrl-C
re-stash check changed from a boolean ("did a stash entry exist at branch start") to a COUNT
(`quarantinedAtStart`/`quarantinedDiffAtStart`), and that `restore-blocked-diff.ts`'s reproduction-
tamper check flipped from "always drop on mismatch" to "keep with a tamper note when the pop itself
restored the mismatching test, drop otherwise." Both needed the same three-home treatment. Two more
homes joined the set that day:

- `SECURITY.md` § "Bundled skills … unless the folder is a leftover of ralphctl's own" — gained the
  stale-install replacement's info-level log line (path, skill, dead pid). Not one of the original
  three/four, but same pattern: code behavior change → doc claim goes stale same-day.
- `DESIGN-SYSTEM.md`'s "Reconciling a live trace against the polled entity" paragraph (Tasks-panel /
  sprint-detail bucket-vs-entity reconciliation) — a doc claim ("both corrections settle-gated") was
  WRONG the moment it was written, not just stale; a reviewer caught it by tracing
  `overlayEntityBlockedStatus` in `bucket-task-signals.ts` line-by-line. Lesson: for a freshly-added
  paragraph describing an asymmetric guard (`isRunning` gates one arm of a loop but not another), read
  the actual conditional, don't infer symmetry from the surrounding prose.

Also: `setup-script-runner.ts`'s resume gate reads as "latest SUCCESS row" in loose paraphrase but the
code is "latest row ignoring `'skipped'`, which must ITSELF be success" — a later failed/spawn-error
row after a real success now forces a re-run. This distinction is easy to lose in a summary; when
touching this doc passage, quote the `findLast(...outcome !== 'skipped')` shape rather than
paraphrasing "latest success."
