---
name: project_worktree_teardown_quarantine_count_review
description: Verified fix (2026-09-17) for findings 1-5 on fix/review-followups-parallel-unblock — quarantine boolean→count, dropped tamper-note-on-restore bug, two stale scheduler comments, adopt-persisted-blocks doc, and a no-op vitest assertion
metadata:
  type: project
---

Independently verified (branch `fix/review-followups-parallel-unblock`, 2026-09-17) all five fixes
from the fixer's report against the binding decisions:

1. `wave-scheduler.ts` — the two stale comments (line ~130 `runWaves` doc, `toOutcome` comment)
   now correctly say a `failed` `BranchOutcome`'s `ctx`/`error` is diagnostics-only, matching the
   already-rewritten `BranchOutcome` JSDoc. Comment-only, confirmed via diff.
2. `merge-wave.ts` / `flow.ts` — `adoptPersistedBlocks` doc no longer cites a fold-conflict as a
   persisted-then-errored example (`conflictFold` never writes `taskRepo` and always returns `ok`);
   `flow.ts:483` now correctly attributes `adopt-persisted-blocks` (reconcile) as prefixed onto
   `buildImplementEpilogue`'s own leaves, not one of them.
3. `worktree-teardown.ts` / `wave-branch.ts` — boolean presence check replaced with a `count`
   (`quarantinedAtStart: number`, `snapshotQuarantinedDiff` counts entries matching the task's key
   via `stashEntryMatchesMessage`). `requarantineRestoredDiff` re-stashes when the current count is
   lower than at branch start. The commit gate (`readPersistedOutcome`) now looks only at the LAST
   attempt this branch opened, not `.every()` over all attempts — closes a related latent bug. A
   real-git regression test seeds two same-key entries, pops the newer, interrupts mid-generator,
   and asserts BOTH entries land back in the stash (newer holds restore + interrupted work, older
   untouched) — this is exactly the scenario the pre-fix boolean logic loses (an older entry still
   listed reads as "nothing was popped", so the re-stash is skipped and the newer diff is destroyed).
   `wave-branch.ts`'s diff was NOT scoped to only the quarantine-snapshot part in the working tree —
   it's interleaved with a concurrent agent's `worktree-setup-tree.ts` feature in the same file — but
   the fixer's own addition (`quarantinedAtStart` snapshot before `setupWorktree`, threaded into
   `WorktreeTeardownArgs`) is minimal, correctly placed before worktree creation, and doesn't touch
   the setup-script code path.
4. Two `not.toContain(expect.stringContaining(...))` no-op assertions (vitest's `toContain` ignores
   asymmetric matchers — verified this really is a permanent pass) replaced with
   `.filter(s => s.endsWith(...)).toHaveLength(0)`, matching the correct pattern already used
   elsewhere in the same file.
5. `restore-blocked-diff.ts` — a restored-but-tampered reproduction test is now kept (not dropped)
   when the pop actually restored a change to that specific path (`git status --porcelain
--untracked-files=all -- :(literal)<testPath>`), so the evaluator still gets
   `REPRODUCTION_TAMPER_NOTE`. **Deviation from the literal binding text** ("drop only when
   missing/unreadable"): the fixer also drops when the file is present-but-differs but the pop was
   skipped/undone/touched-a-different-entry, reasoning that the reproducer prefers editing an
   existing test file so a skipped-pop tree usually holds the plain committed copy, and keeping the
   artifact there would falsely accuse the AI of tampering it never did. This is a narrower, more
   conservative "keep" than the decision's binary split. I judged this an acceptable, well-reasoned
   edge-case call (not a functional regression) rather than a Must-Fix: the common path the finding
   actually described (weakened test carried through a successful pop) is correctly kept and has
   both a unit and a real-git test pinning it.

Checks run clean: `npx vitest run` on all 8 directly-touched test files (163 tests) plus the
broader `tests/unit/application/flows/implement/`, `tests/integration/application/flows/implement/`,
`tests/unit/application/chain/` sweep (858 tests) — all green. `pnpm typecheck` exit 0. `npx eslint
--max-warnings 0` and `npx prettier --check` clean on all touched source + test files.

See also [[project_pre_0_22_0_review_followups]] (the earlier PR #337 follow-up review from the
same campaign) and [[project_parallel_setup_tree_check_review]] (the concurrent setup-tree-check
feature reviewed separately, sharing `wave-branch.ts`).
