---
name: project_unified_windowed_list
description: Design decision — unified useListWindow hook + WindowedList component replacing CardList/ListView/computeWindow; ScrollRegion suppressArrows arbitration; full convergence adoption plan for all 6 list views (Jun 2026)
metadata:
  type: project
---

## Decision

Replace the three coexisting list-navigation mechanisms (CardList, ListView, computeWindow/RowWindowView) with one unified primitive: `useListWindow` hook + optional `<WindowedList>` render component. Located at `src/application/ui/tui/components/windowed-list.tsx`.

**Why:** three mechanisms with inconsistent keys, index-based cursors that desync on live-reorder (sessions-view L7), flat unwindowed lists in sprint-detail and pick-project, and a double-handle arrow bug in sprint-detail where both the cursor and ScrollRegion fire on the same keypress.

## Key design points

- ID-based cursor (`cursorId: string`) — survives reorder and eviction.
- Windowing: `computeListWindow(totalItems, focusedIndex, visibleRows)` pure helper.
- Uniform keys: ↑/↓ (primary), j/k (alias), PgUp/PgDn, Home/End, Enter.
- Overflow: `<OverflowRow>` using `glyphs.moreAbove` / `glyphs.moreBelow` (already in tokens.ts at lines 69-72).
- `useListWindow` for complex views (sprint-detail, pick-sprint); `<WindowedList>` for simple views (sessions, pick-project, sprints, projects).

## ScrollRegion arbitration

Add `suppressArrows?: boolean` to `scroll-region.tsx` props. Add `suppressScrollArrows?: boolean` to `view-shell.tsx` props, threaded down to ScrollRegion. Views with list cursors pass this to avoid double-handling ↑/↓/PgUp/PgDn.
Mouse-wheel (stdin SGR listener) is NOT suppressed — no list-cursor conflict.

## Adoption plan (in order)

1. `windowed-list.tsx` + tests (blocking foundation)
2. `scroll-region.tsx` + `view-shell.tsx` suppressArrows (blocking for sprint-detail)
3. Migrate `sprint-detail` — highest value, most broken (double-handle + no windowing)
4. Migrate `sprints-view` + `projects-view` (CardList → useListWindow)
5. Migrate `sessions-view` (ListView → useListWindow; fixes L7 id-cursor desync)
6. Migrate `pick-project-view` (flat map → useListWindow)
7. Augment `pick-sprint-view` in place — add PgUp/PgDn/Home/End to useInput; keep heterogeneous-row structure
8. Delete CardList + ListView; update DESIGN-SYSTEM.md

## pick-sprint special case

pick-sprint uses heterogeneous rows (header/sprint/create) handled by `nextCursorableIndex`. Migration to `useListWindow` requires a `isCursorable` predicate extension that is not worth the complexity. Augment in place only.

## Shared files (parallel-implementation collision risk)

- `view-shell.tsx` + `scroll-region.tsx` must land together before sprint-detail migration
- `card-list.tsx` deleted after both sprints + projects migrations land
- `list-view.tsx` deleted after sessions migration lands
- `DESIGN-SYSTEM.md` updated last, in one PR

## Why: The owner navigates with arrow keys primarily; j/k are secondary. Consistency across all list views is the explicit requirement.

How to apply: Any new list surface in the TUI must use useListWindow (or WindowedList). Never add a new flat .map() list without windowing for potentially-unbounded data.
