---
name: lesson-fake-timers-and-spinner
description: Fake timers with ink-testing-library: advanceTimersByTimeAsync, forced re-renders, chrome false matches
metadata:
  type: feedback
---

`vi.useFakeTimers()` plus `vi.runAllTimersAsync()` loops forever on Ink's Spinner `setInterval`. Use
`vi.advanceTimersByTimeAsync(N)`.

- Time-gated render conditions (a toast freshness check): advance with
  `vi.spyOn(Date, 'now').mockReturnValue(BASE + 3100)`, then force a re-render through a context state change
  (a helper component calling `selection.setSprint(...)` in a once-only `useEffect`). `setLocalError((c) => c)` bails
  out of rendering (same value), so it forces nothing.
- Intercept context calls without forking the provider: `Object.assign(selection, { setSprint: spy })` from a child
  component's `useEffect`.
- `frame.indexOf('Alpha Project')` matches ViewShell breadcrumb chrome. Filter lines containing `'project:'` to find
  the real group header row.
- Use `.tsx` for any test that renders React, even a unit test.
