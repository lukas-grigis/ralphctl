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

## Status: SHIPPED

The convergence landed — `card-list.tsx` and `list-view.tsx` are deleted, `windowed-list.tsx` is present, and the
views migrated onto `useListWindow` / `<WindowedList>`. `pick-sprint-view` kept its heterogeneous-row structure
(header/sprint/create handled by `nextCursorableIndex`) and was augmented in place rather than forced onto the
windowed primitive — its `isCursorable` predicate extension wasn't worth the complexity.

## Why: The owner navigates with arrow keys primarily; j/k are secondary. Consistency across all list views is the explicit requirement.

How to apply: Any new list surface in the TUI must use useListWindow (or WindowedList). Never add a new flat .map() list without windowing for potentially-unbounded data.
