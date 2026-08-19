---
name: progress-overlay-flake-elimination
description: Eliminate flaky ink-testing-library overlay/scroll tests by asserting on a SEEDED sentinel via waitFor instead of a fixed tick delay
metadata:
  type: feedback
---

Pattern: add a SEEDED sentinel text to `SeedSelection` that renders only when `seeded=true` (sprint
or focusedRun effect has committed). Replace `await tick(50)` with
`await waitFor(() => lastFrame().includes('SEEDED'))`.

The sentinel stays visible even after the overlay opens (SeedSelection renders outside
GlobalHarness's conditional), so asserting overlay content and `not.toContain('UNDERLYING_VIEW')`
still works.

For scroll clamp assertions: replace the final fixed tick after PgDn/PgUp loops with
`waitFor(() => lastFrame().includes('TAIL-LINE'))` or
`waitFor(() => lastFrame().includes('HEAD-LINE'))`.

Proved: 10/10 isolated runs pass, 689/689 tui suite passes (as of 2026-06-12 — see
`project_flaky_progress_overlay_test` in the user auto-memory for the fix landing).
