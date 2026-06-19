---
name: project_implement_header_effort_sidebyside
description: HeaderCard two-line gen/eval model+effort display, and side-by-side Baseline+Token cards in sidebar at ≥xl (Jun 2026)
metadata:
  type: project
---

## Task A — HeaderCard: explicit generator + evaluator lines

**Decision:** For implement runs, the HeaderCard always renders TWO labelled lines — `generator <model> · <effort>` and `evaluator <model> · <effort>` — even when the two models are equal. The old single `<gen> → <eval> (eval)` format is gone.

**Why:** The operator needs unambiguous role visibility; the collapsed single-line format hid the evaluator on same-model runs.

**Threading chain:**

1. `launch/implement.ts` — `generatorEffort`/`evaluatorEffort` already computed; added to returned LaunchResult.
2. `launcher.ts` — added to `LaunchResult` type + `sessionHintsFromLaunchResult` projection.
3. `session-manager.ts` — added to `SessionDescriptor` + `register()` input type + descriptor construction.
4. `header-card.tsx` — new `ModelLines` subcomponent; renders two lines when both models set, one `model` line for non-implement flows.

**Effort vocabulary:** Raw resolved string (`low|medium|high|xhigh|max`); rendered verbatim, no abbreviation.

## Task B — Side-by-side Baseline + Token cards in sidebar

**Decision:** At ≥xl (180 cols), the `BaselineHealthCard` and `TokenBudgetCard` render side-by-side in a single horizontal row at the top of the sidebar. Below xl (< 180 cols, sidebar = 56) they stay stacked.

**Why:** At 140 cols sidebar = 56 exactly = 2 × CONTEXT_WIDTH (28), zero gutter — stacking is safer. At xl (180 cols) sidebar = 72, giving each card 28 cols with 16 to spare. Side-by-side reclaims ~7 vertical rows for the log panel.

**New field:** `sidebarContextSideBySide: boolean` added to `ResponsiveLayout` interface and computed in `useResponsiveLayout` as `columns >= breakpoints.xl`.

**Component changes:**

- `implement-sidebar.tsx` — `sidebarContextSideBySide` prop; branched render: row vs stack.
- `implement-layout.tsx` — passes `layout.sidebarContextSideBySide` to `ImplementSidebar`.
- `use-responsive-layout.ts` — computes + returns the new boolean field.

**TokenBudgetCard width:** uses its own internal `CONTEXT_WIDTH` — no `width` prop accepted.

## Test updates

Tests checking `Steps < Tokens` order (visual-verification.test.tsx at 200×50, 240×60) updated to reflect new side-by-side order (`Tokens < Steps` at ≥xl). Tests checking old `→`/`(eval)` model line format (execute-view.test.tsx) updated to check for `generator`/`evaluator` labels instead.

**How to apply:** When adding new sidebar cards, check `sidebarContextSideBySide` to decide whether side-by-side is viable. The xl threshold (180 cols) is the canonical breakpoint for sidebar horizontal composition.
