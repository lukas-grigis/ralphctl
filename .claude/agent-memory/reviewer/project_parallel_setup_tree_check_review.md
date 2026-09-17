---
name: project_parallel_setup_tree_check_review
description: Parallel worktree setup check (2026-09-17) — binding seen-paths mapping replaced the design's self-defeating outcome-based "kept" mapping; verified clean
metadata:
  type: project
---

Reviewed and passed (2026-09-17, branch `fix/review-followups-parallel-unblock`): the parallel
per-worktree setup working-tree check (`src/application/flows/implement/worktree-setup-tree.ts`,
`src/integration/io/git-tree-snapshot.ts`, `SetupTreeRecord` on `SprintExecution`/`SetupRun`).

The Opus design's `worktreeSetupDirtAction` mapped worktree action off main's coarse
`SetupTreeOutcome` ('kept' → keep). The design's own risk section flagged this as self-defeating —
verified with real git that a worktree commit carrying a change main _kept_ uncommitted always
fails to fold (`ff-only` exits 1, cherry-pick exits 128). A binding user decision replaced the outcome-based mapping with a
**seen-paths** mapping: `SetupTreeRecord.seenPaths` records every path the operator has _already
seen_ (pre-setup dirt kept/continued + whatever setup introduced), capped at 200
(`SETUP_TREE_SEEN_PATHS_MAX`). Per introduced worktree path: seen → discard (whatever main's
outcome was); unseen → policy `continue` keeps with a warning, `prompt`/`cancel` blocks; no record
at all → block. This is strictly more correct than the design's table — it also fixes the design's
flagged "'unchanged' is ambiguous at entry granularity" risk, since pre-existing main dirt now
always lands in `seenPaths` regardless of outcome.

**Why this is worth remembering:** when a change ships with both a design doc and a later
"BINDING USER DECISION" block that supersedes part of it, verify against the binding block, not the
design's original table — the design's own `risks` section had already flagged the exact defect the
binding decision fixes. Cross-check the design's `risks` field against the binding text; if a risk
is unaddressed by the binding, that is a real Must-Fix, not a design nitpick.

Implementation matched the binding decision exactly: `worktreeSetupDirtAction` is a pure,
unit-tested function (`tests/unit/application/flows/implement/worktree-setup-tree.test.ts`);
resume-skip now requires the record on the _latest_ success row (fixes a latent stale-row bug, not
just first-match); `SetupTreeRecordSchema.tree` parses tolerantly (`.optional().catch(undefined)`)
per the project's tolerant-reader rule; `AbortError` propagates untouched through
`preflightTaskUseCase`'s prompt path. Real-git e2e (`tests/e2e/flows/implement-parallel-realgit.test.ts`,
describe `'a setup script that changes the tree (real git)'`) covers keep/stash/worktree-only-change
and asserts clean folds — this is the scenario the design's risk section predicted would fail, and
it now passes. All of typecheck/lint/prettier/deadcode clean; 792 implement-flow tests + this
change's 216 targeted tests green.
