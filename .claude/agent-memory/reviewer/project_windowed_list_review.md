---
name: project_windowed_list_review
description: Key findings from the windowed-list / ScrollRegion suppressArrows review on ui-ux-stabilization branch
metadata:
  type: project
---

Reviewed branch: ui-ux-stabilization (commit range against main).

**Key architecture facts learned:**

- `WindowedList` export was dead (no importer) — `pnpm deadcode` exited 1. RESOLVED: `@public`-tagged (it is the documented DESIGN-SYSTEM §6.4 list primitive; views consume the `useListWindow` hook directly).
- `sprint-detail-view.windowing.test.tsx` is a NEW test added on this branch; the reviewer flagged it as flaky under full-suite load (used `tick(60)`), but three subsequent full-suite runs were green — treat as a latent timing risk, not a confirmed failure. `waitForViewReady` is the robust pattern if it ever flakes.
- `progress-overlay.test.tsx` is the pre-existing known flaky test; unrelated to this branch.
- `badge.tsx` became an unused file ON THIS BRANCH (its only consumer, `flows-view`, was dropped in the flow-clarity refactor); `knip` passes on `main`, so this WAS a branch regression of the deadcode invariant. RESOLVED: file + its DESIGN-SYSTEM row removed.
- `pick-sprint-view` is NOT migrated to `useListWindow` — still uses index-based `computeWindow` + its own `useInput` arrows. RESOLVED the double-scroll by adding `suppressScrollArrows` to its `ViewShell`; the full `useListWindow` migration is still deferred.
- `scroll-region.tsx` module comment referenced deleted `ListView, CardList` — RESOLVED (points at `useListWindow` now).
- `suppressArrows` is implemented correctly: early return in the handler body (not `isActive: false`), so keys fall through to `useListWindow`'s handler.

**Why:** These facts are non-obvious from reading code alone and help future reviewer/implementer agents avoid false positives. The RESOLVED markers record that the pre-merge fix pass (PR #190) addressed each item.

**How to apply:** When reviewing or implementing in the windowed-list / scroll-region area, check deadcode (`pnpm deadcode`) immediately — and beware the trailing-`echo` trap: `pnpm cmd | tail; echo done` reports `echo`'s exit (0), masking a real non-zero from `cmd`. Run the gate as its own command to read its true exit.
