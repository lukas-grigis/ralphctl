---
name: project_execute_view_responsive_layout
description: Execute-view layout rules that survive constant changes: sidebar section order, one shared height budget, narrow-rail suppression, Ink text invariants
metadata:
  type: project
---

The arithmetic lives in `execute-view-internals/use-responsive-layout.ts` and `theme/tokens.ts`. Read them for the
current numbers; do not copy constants into new code or docs.

- **Sidebar section order (keep it):** BaselineHealthCard, ModelMeta, Steps tree, Tasks minimap, TokenBudgetCard
  (bottom-pinned). New per-run meta goes into BaselineHealthCard or ModelMeta, never a new page-level row.
  `TaskNavList` is a passive minimap and captures no keys; `TasksPanelHost` in the main column is the sole input owner.
- **One shared height budget.** The two flexible sidebar sections partition a single `sidebarBodyRows`; they must never
  scale with `rows` independently (that once pushed the TokenBudgetCard off-screen).
- **Step display = one projection.** `useFlowProgress` runs once in the view; the header strip, every `FlowStepsTree`
  and each card's `TaskStepTree` read it. The descriptor keeps one reference while trace and `live` mutate, so a
  component that takes the descriptor and memoises on it freezes (the old rail did). Each step row is one truncating
  `Text`, with a failed row's message on its own row, so a long path can't wrap the narrow sidebar.
- **Flows without task work items** (`!progress.hasTaskWorkItems`) show the Steps tree where Tasks would be and drop
  the sidebar Steps section; sessions with no plan tree behave as task flows.
- **`xl` is the canonical breakpoint for pairing cards horizontally** (`sidebarContextSideBySide`); check that flag
  before adding a card that might pair.
- **Step ids never embed paths.** Use the optional `label` on the element; step rows render `label ?? name`.
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
