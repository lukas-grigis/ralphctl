---
name: project_unblock_reopen_review
description: Unblock/reopen toast fixes (u-again truthfulness, no false success on a retried review→active, bulk toast parity) — verified; a shared business fn feeds three presentation layers
metadata:
  type: project
---

Verified the unblock/reopen toast fixes (2026-09-17, branch `fix/review-followups-parallel-unblock`). All three fixes are correct, tested test-first,
green on typecheck/lint/prettier/knip, no edits outside the assigned file boundary.

**The "u again" toast** (sprint-detail's "then u again" was untrue): fixed with a real `r` reload chord in
`sprint-detail-internals/shortcuts.ts` mirroring `sprints-view.tsx`, wired through a new
`detail-shortcuts-actions.ts` (extracted from `detail-body.tsx` to stay under the 400-line ESLint budget —
note `wc -l` shows 501 raw lines but `max-lines` skips blanks/comments, so eslint is still clean; don't judge
this rule by raw `wc -l`). Proven by
`tests/integration/application/ui/tui/views/sprint-detail-unblock-external-reopen.test.tsx`, which mutates a
stubbed repo out-of-process between keypresses (simulating a second-terminal `sprint reopen`) — genuinely
end-to-end, not just a copy check.

**False success** (false success tick when a retried `review`→`active` hop fails again): fixed at the business
layer in `business/task/unblock-task.ts` — both `unblockTaskUseCase`'s tail and `finishInterruptedReopen` now
report `{from:'review', sprint: stillReviewSprint}` instead of `undefined` on a second failure, so
`sprintReopened !== undefined` no longer conflates "nothing needed reopening" with "reopen failed twice."
`UnblockTaskOutput`'s shape unchanged — CLI stays type-compatible.

**Leftover wording nit (FIXED before merge — CLI and bulk toast now say "still review" when `from === to`):** the CLI (`ui/cli/commands/task.ts`)
shares `unblockTaskUseCase` and was NOT updated — for the exact scenario the new unit tests cover (a second
`review`→`active` failure), the CLI will now print `reopened sprint 'x' (id) review → review` (misleading —
nothing moved) immediately followed by its existing `note: ... did not persist` clarifier. Previously this
case reported `sprintReopened: undefined` and the CLI printed nothing about "reopened" at all (silent, not
misleading). The TUI's own toast (`detail-handlers.ts`'s `unblockedToast`) was given a `from === sprint.status`
check that renders "sprint still review" instead — the same fix was never mirrored into
`ui/cli/commands/task.ts`'s output text. Same-class defect also survives, unfixed, in
`sprints-view-internals/unblock-feedback.ts`'s `reopenedClause` (bulk TUI toast) — it always renders
`sprint reopened {from} → {to}` with no equal-check, so the identical stray-todo-retry-fails-again case
prints "sprint reopened review → review, not active" there too. In both leftover spots the **glyph/exit-code
signal is still correct** (CLI's follow-up note + TUI's warning glyph both correctly avoid claiming clean
success) — it's the "reopened X → X" text specifically that's confusing, not a functional regression.

**Bulk toast parity** (bulk toast had no follow-up after a refused reopen): fixed by threading `sprintId` +
`reopenHint` (from `ConflictError.hint`, not just `.message`) into `unblock-feedback.ts`'s
`formatUnblockFeedback`, appending the same retry clause sprint-detail uses. Also fixed the bulk head glyph
to downgrade from `✓` to `⚠` whenever a reopen was refused or stalled short of `active` (this is where
the "no false success" requirement is actually satisfied on the bulk path).

**Review lesson:** when a fix touches a shared business-layer function (`unblock-task.ts`) that feeds THREE
presentation layers (sprint-detail TUI, sprints-view bulk TUI, CLI), check all three call sites render the
newly-enriched output correctly — a fixer whose file-ownership boundary excludes the CLI can still change the
CLI's _behavior_ by enriching the shared Result, without it showing up in `git diff` on any CLI file.
