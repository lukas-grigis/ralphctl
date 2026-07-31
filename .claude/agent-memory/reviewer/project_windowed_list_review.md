---
name: project_windowed_list_review
description: Windowed-list / ScrollRegion review findings, plus the headered-list migration hazard (window bounds only the cursorable subset once headers are re-attached)
metadata:
  type: project
---

Reviewed branch: ui-ux-stabilization (commit range against main).

**Key architecture facts learned:**

- `WindowedList` export was dead (no importer) — `pnpm deadcode` exited 1. RESOLVED: `@public`-tagged (it is the documented DESIGN-SYSTEM §6.4 list primitive; views consume the `useListWindow` hook directly).
- `sprint-detail-view.windowing.test.tsx` is a NEW test added on this branch; the reviewer flagged it as flaky under full-suite load (used `tick(60)`), but three subsequent full-suite runs were green — treat as a latent timing risk, not a confirmed failure. `waitForViewReady` is the robust pattern if it ever flakes.
- `progress-overlay.test.tsx` is the pre-existing known flaky test; unrelated to this branch.
- `badge.tsx` became an unused file ON THIS BRANCH (its only consumer, `flows-view`, was dropped in the flow-clarity refactor); `knip` passes on `main`, so this WAS a branch regression of the deadcode invariant. RESOLVED: file + its DESIGN-SYSTEM row removed.
- `pick-sprint-view` WAS migrated to `useListWindow` (2026-08-01 fix campaign) — id-keyed cursor lives in `PickerRowList`; `pick-sprint-internals/window.ts`'s `computeWindow` then had zero production callers and survived only via the `@public` re-export + `tests/unit/.../pick-sprint-window.test.ts`.
- `scroll-region.tsx` module comment referenced deleted `ListView, CardList` — RESOLVED (points at `useListWindow` now).
- `suppressArrows` is implemented correctly: early return in the handler body (not `isActive: false`), so keys fall through to `useListWindow`'s handler.

**Headered-list migration hazard (check this on every `useListWindow` migration of a grouped list):** the
established pattern (`action-menu.tsx`, now `pick-sprint-internals/row-views.tsx`) windows over the _cursorable
subset_ and re-attaches headers for rendering. That silently drops the "rendered height ≤ `visibleRows`" property
the pre-migration `computeWindow(rows.length, …)` had, because each re-attached header adds lines on top of the
window — and any "always render this header regardless of the window" exemption makes the overshoot unbounded in
group count. It bites hard specifically because these views pass `suppressScrollArrows`, so `ScrollRegion`'s
keyboard scroll is off and overflowed content is unreachable without a mouse. Cheap fix shape: keep `useListWindow`
for cursor + keys over the cursorable subset, but derive the _render_ slice from
`computeListWindow(rows.length, indexOfFocusedInRows, visibleRows)` over the full flat row list.

**Why:** These facts are non-obvious from reading code alone and help future reviewer/implementer agents avoid false positives. The RESOLVED markers record that the pre-merge fix pass (PR #190) addressed each item.

**How to apply:** When reviewing or implementing in the windowed-list / scroll-region area, check deadcode (`pnpm deadcode`) immediately — and beware the trailing-`echo` trap: `pnpm cmd | tail; echo done` reports `echo`'s exit (0), masking a real non-zero from `cmd`. Run the gate as its own command to read its true exit.
