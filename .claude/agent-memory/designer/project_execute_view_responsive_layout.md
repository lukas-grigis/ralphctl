---
name: project_execute_view_responsive_layout
description: Execute-view responsive layout — sidebar composition and height budget, rail width and narrow-rail suppression, HeaderCard model lines, side-by-side context cards
metadata:
  type: project
---

All of this lives in `execute-view-internals/use-responsive-layout.ts` (the single arithmetic home),
`implement-sidebar.tsx`, `rail.tsx`, `header-card.tsx`, and `theme/tokens.ts`. Read the hook before
changing any number here — it carries the current values and the reasoning as comments.

## Sidebar composition (≥140 cols, `sidebarLayout`)

`StatusBand` is gone; the sidebar carries the meta it used to hold, and `BaselineHealthCard` is a full
bordered card at the top rather than a page-level chip. Column labels (`[nav]` / `[tasks]`) are gone.

Section order, top → bottom — **keep it**: BaselineHealthCard → ModelMeta → Steps rail → Tasks minimap
→ TokenBudgetCard (bottom-pinned). `HeaderCard` sits above the column split at all widths;
`ImplementMainArea` (main column) hosts `TasksPanelHost`, the sole input owner. `TaskNavList` is a
passive minimap and captures no keys.

Where each piece of meta lives: sprint title/status/elapsed → HeaderCard; generator + evaluator models
→ ModelMeta; baseline health → BaselineHealthCard; task minimap → TaskNavList; flow steps →
FlowStepsRail; token summary → TokenBudgetCard. **New per-run meta goes into BaselineHealthCard or
ModelMeta**, not into a new page-level row.

`sidebarWidth = max(34, round(columns * 0.4))` — a genuine 2/5 split with a legibility floor and no
upper cap.

## Height budget

One shared `sidebarBodyRows` budget is partitioned between the two flexible sections; the sections must
never scale with `rows` independently (the original bug allocated 47 of 50 rows to two sections and
pushed the TokenBudgetCard off-screen). Current shape:

```
sidebarBodyRows      = max(0, rows - PAGE_CHROME_ROWS - SIDEBAR_CHROME_ROWS - logRows)
sidebarFlowStepsRows = min(SIDEBAR_STEPS_CAP, max(0, floor(sidebarBodyRows * 0.35)))
sidebarTaskNavRows   = max(SIDEBAR_TASK_NAV_MIN, sidebarBodyRows - sidebarFlowStepsRows)
```

`tasksMaxBlocks` in sidebar layout is `max(3, floor((rows - PAGE_CHROME_ROWS - logRows) / 3))` — ~3
rows per card, not the legacy `(rows - 14) / 4`, because the main area owns the full column height and
collapsed cards are 2–3 rows.

## Rail width and narrow-rail suppression

`resolveRailWidth(columns)` in `tokens.ts` is a pure function called once — the rail widens responsively
and labels truncate at the rail boundary. Do not revert to a fixed `RAIL_WIDTH` at three-column widths.
Root cause of the original wrapping at ≥180 cols: a fixed 24-char rail; the wasted right-hand space at
~200 cols was the Context column being `flexShrink={0}` with no balancing `flexGrow`, not a ViewShell bug.

`FlowStepsRail` sets `suppressMeta` when `railWidth < NARROW_RAIL_SUPPRESS_META_THRESHOLD` (32, defined
in `rail.tsx`) — each row then renders only glyph + name, dropping duration, trailing status label, and
error message. **Any `FlowStepsRail` in a column narrower than that threshold must set it**, otherwise
the meta concatenates into the step name.

**Step-ID / label separation:** `Element` and `TraceEntry` carry an optional `label?: string`; `leaf`
takes it via the optional third param `opts?: { label?: string }`; `StepTrace` renders
`row.label ?? row.name`. Flow definitions never embed paths in ids — use a label.

## HeaderCard model lines

For implement runs the HeaderCard always renders TWO labelled lines — `generator <model> · <effort>` and
`evaluator <model> · <effort>` — even when the models are equal; the collapsed `<gen> → <eval> (eval)`
format hid the evaluator on same-model runs. Non-implement flows get one `model` line. Effort renders
verbatim from the resolved string, never abbreviated.

Threading chain when adding a new per-session header field: `launch/implement.ts` → `LaunchResult` in
`launcher.ts` (+ `sessionHintsFromLaunchResult`) → `SessionDescriptor` + `register()` in
`session-manager.ts` → `header-card.tsx`.

## Side-by-side context cards

`sidebarContextSideBySide` (in `ResponsiveLayout`, computed as `columns >= breakpoints.xl`) puts
`BaselineHealthCard` and `TokenBudgetCard` in one horizontal row at the top of the sidebar, reclaiming
~7 rows for the log panel. Below xl they stay stacked: at 140 cols the sidebar is 56 = exactly
2 × `CONTEXT_WIDTH` with zero gutter. **xl is the canonical breakpoint for sidebar horizontal
composition** — check this flag before adding a card that might pair.

## Ink rendering invariants (learned the hard way)

- **Never rely on trailing spaces inside a styled `<Text>`** — Ink collapses them, producing
  `modelclaude-…`. Use a separate `<Text> </Text>` separator node.
- **Never use sibling `<Text>` nodes in a `<Box>` for a label+value pair** — Ink gives each 50% flex
  width and it wraps. Use a single outer `<Text>` with nested `<Text>` for colour.
- Token honesty (`token-budget-card.tsx`): `isCumulative = totalUsed > contextWindow`; when true render
  `session: N (cumulative)` with NO bar and NO percentage — otherwise cumulative `claude -p` data shows
  an absurd "2.2M / 200k 100%". Cache-hit rate is `cacheRead / (cacheRead + input)`, always 0–100%.

Related: [[project_execute_view_terminal_state]], [[feedback_baseline_card_row_pattern]].
