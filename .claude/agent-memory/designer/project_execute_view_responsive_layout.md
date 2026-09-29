---
name: project_execute_view_responsive_layout
description: Execute-view layout rules that survive constant changes: sidebar section order, one shared height budget, narrow-rail suppression, Ink text invariants
metadata:
  type: project
---

The arithmetic lives in `execute-view-internals/use-responsive-layout.ts` and `theme/tokens.ts`. Read them for the
current numbers; do not copy constants into new code or docs.

- **Sidebar section order (keep it):** BaselineHealthCard, ModelMeta, Steps rail, Tasks minimap, TokenBudgetCard
  (bottom-pinned). New per-run meta goes into BaselineHealthCard or ModelMeta, never a new page-level row.
  `TaskNavList` is a passive minimap and captures no keys; `TasksPanelHost` in the main column is the sole input owner.
- **One shared height budget.** The two flexible sidebar sections partition a single `sidebarBodyRows`; they must never
  scale with `rows` independently (that once pushed the TokenBudgetCard off-screen).
- **Rail width is responsive, not fixed.** Use `resolveRailWidth(columns)`. `FlowStepsRail` drops step meta below
  `NARROW_RAIL_SUPPRESS_META_THRESHOLD` (`execute-view-internals/rail.tsx`) unless `suppressMeta` is passed explicitly;
  a narrow rail with meta forced on concatenates it into the step name.
- **`xl` is the canonical breakpoint for pairing cards horizontally** (`sidebarContextSideBySide`); check that flag
  before adding a card that might pair.
- **Step ids never embed paths.** Use the optional `label` on `leaf`; `StepTrace` renders `row.label ?? row.name`.
- **HeaderCard:** implement runs always show two labelled lines, generator and evaluator, even when the models match
  (the collapsed form hid the evaluator). Effort renders verbatim. A new per-session header field threads through
  `launch/implement.ts`, `LaunchResult`, `SessionDescriptor` in `session-manager.ts`, then `header-card.tsx`.
- **Token honesty:** when cumulative usage exceeds the context window render `session: N (cumulative)` with no bar and
  no percentage.

**Ink invariants:**

- Never rely on trailing spaces inside a styled `<Text>`; Ink collapses them (`modelclaude-…`). Use a separate
  `<Text> </Text>` node.
- Never use sibling `<Text>` nodes in a `<Box>` for a label/value pair; each gets 50% flex width and wraps. Use one
  outer `<Text>` with nested coloured `<Text>`.

Related: [[feedback_baseline_card_row_pattern]].
