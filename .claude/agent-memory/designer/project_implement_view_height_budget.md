---
name: project_implement_view_height_budget
description: Sidebar height-budget model for ImplementSidebar — shared budget partitioning prevents overflow (Jun 2026)
metadata:
  type: project
---

# Implement View Height Budget Fix (Jun 2026)

## The Bug

`sidebarTaskNavRows = rows - 19` and `sidebarFlowStepsRows = rows - 22` both scaled with terminal `rows` independently. On a 50-row terminal this allocated 31+16=47 rows to just two sidebar sections, pushing the TokenBudgetCard and header off-screen.

## The Fix

Compute a single `sidebarBodyRows` budget from a shared formula, then split it between the two sections:

```ts
const PAGE_CHROME_ROWS = 8; // header chip + HeaderCard + log section chrome + footer
const SIDEBAR_CHROME_ROWS = 18; // sprint meta + dividers + section headers + TokenBudgetCard + BaselineHealthCard
const SIDEBAR_STEPS_CAP = 10; // max rows for flow-steps rail
const SIDEBAR_STEPS_MIN = 4;
const SIDEBAR_TASK_NAV_MIN = 4;

const sidebarBodyRows = Math.max(0, rows - PAGE_CHROME_ROWS - SIDEBAR_CHROME_ROWS - logRows);
const sidebarFlowStepsRows = Math.min(
  SIDEBAR_STEPS_CAP,
  Math.max(SIDEBAR_STEPS_MIN, Math.floor(sidebarBodyRows * 0.4))
);
const sidebarTaskNavRows = Math.max(4, sidebarBodyRows - sidebarFlowStepsRows);
```

## Key Outcomes at Common Sizes

| rows | running | bodyRows | steps | taskNav | total           |
| ---- | ------- | -------- | ----- | ------- | --------------- |
| 50   | yes     | 18       | 7     | 11      | 18              |
| 35   | yes     | 3        | 4     | 4       | 8 (min-floored) |
| 60   | yes     | 28       | 10    | 18      | 28              |

## Ink Label + Space Pattern

`<Text dimColor>label </Text>` — Ink collapses trailing spaces before adjacent Text nodes. Always use a separate `<Text> </Text>` node as the separator:

```tsx
<Box>
  <Text dimColor>model</Text>
  <Text> </Text>
  <Text color={inkColors.highlight} wrap="truncate-end">
    {value}
  </Text>
</Box>
```

**Why:** The original code produced "modelclaude-sonnet-4-6" concatenated in the rendered frame.

## Narrow Rail suppressMeta

`FlowStepsRail` passes `suppressMeta={railWidth < 32}` to `StepTrace`. When set, each step row renders only `glyph + name` — duration, trailing status labels, and error messages are omitted. At railWidth=26 (sidebar default), the text budget (22 chars) is fully consumed by the step name; appending " — pending" or "· 1m23s" concatenates into the name.

**How to apply:** Any use of `FlowStepsRail` in a column narrower than 32 chars should set `suppressMeta`. The threshold is defined in `rail.tsx` as `NARROW_RAIL_SUPPRESS_META_THRESHOLD = 32`.

## tasksMaxBlocks in Sidebar Layout

In sidebar layout, use `rows - 10 - logRows / 3` not `rows - 14 / 4` — the main area has more vertical space because tasks fill the full column height, and cards are typically 2-3 rows not 4.
