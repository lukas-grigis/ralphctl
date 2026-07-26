---
name: sprint-selection-redesign-tests
description: Test files + patterns from the sprint-selection redesign (reseat wiring, done-sprint filtering, MakeSpy intercept, fake-timer toast tests, ActionMenu cursor/UUIDv7 ordering)
metadata:
  type: feedback
---

Test files under `tests/integration/application/ui/tui/views/` and `tests/unit/`:

- `sprint-bound-flow-reseat.test.tsx` — reseat wiring contract using a fake runner; asserts
  `setSprint` called on `completed+ctx.sprint`, NOT on `aborted`/`failed`/`started`.
- `tests/unit/application/ui/shared/state-snapshot-done-filter.test.ts` — `loadAppStateSnapshot`
  recentSprints excludes `done` sprints.
- `tests/unit/application/ui/tui/runtime/selection-done-on-boot.test.tsx` — `SelectionProvider`
  clears sprintId/sprintLabel when the rehydrated sprint has `status: 'done'`. **Requires
  `sprintRepo` prop on SelectionProvider.**
- `home-create-hotkey.test.tsx` — `+` on Home routes to create-sprint flow; no-op without a project.
- `home-switch-feedback.test.tsx` — "✓ now on <name>" feedback after switch; disappears after ~3s
  with fake timers.
- `pick-sprint-create-row.test.tsx` — PickSprintView renders "Create new sprint" row BEFORE project
  groups; Enter on it launches create-sprint.
- `sprint-detail-no-auto-sync.test.tsx` — SprintDetailView MUST NOT call `setSprint` on mount
  (inverse of old behaviour). Uses `Object.assign(selection, { setSprint: spy })` (the MakeSpy
  pattern) from a helper component.
- `sprint-detail-make-current.test.tsx` — `m` key calls `setSprint(id, name)`; `· current` badge
  visible when the sprint matches selection.

**MakeSpy / intercept pattern for selection** — `Object.assign(selection, { setSprint: spy })`
inside a child component `useEffect` lets you intercept context calls without forking the provider.

**JSX in test files**: always use `.tsx` even for unit tests that merely import/render React
components.

**Fake timers + ink-testing-library**: `vi.useFakeTimers()` + `vi.runAllTimersAsync()` causes
infinite loops due to Ink's Spinner `setInterval`. Use `vi.advanceTimersByTimeAsync(N)` instead. For
time-gated render conditions (e.g. a toast freshness check), use
`vi.spyOn(Date, 'now').mockReturnValue(BASE_TIME + 3100)` to advance the clock, then force a
re-render via a context state change (e.g. `selection.setSprint(...)` from a helper component) —
`setLocalError((curr) => curr)` bails out of React render (same value → no render committed). The
`SwitchTrigger` helper pattern (a component that calls `selection.setSprint` in a once-only
`useEffect`) is preferred over keyboard navigation for deterministic sprint-switch tests.
`frame.indexOf('Alpha Project')` matches ViewShell breadcrumb chrome — filter lines containing
`'project:'` line-by-line to find the actual group header row instead.

**`ActionMenu` cursor + UUIDv7 ordering**: `makeDraftSprint` generates time-ordered UUIDs; created
later = larger UUID = appears first in `recentSprints` (DESC sort). `initialMenuIndex` seeds to the
current sprint's row. Pressing `k` (up) from the current sprint's row reaches the newer sprint at
index 0.
