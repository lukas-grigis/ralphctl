---
name: project_implement_view_band_layout
description: Implement view sidebar redesign — sidebar section order, width formula, model meta, token labelling (updated Jun 2026)
metadata:
  type: project
---

## Decision (current — post ask #1–6 refinement)

**StatusBand removed.** The sidebar now carries all the meta that StatusBand once held, and the
BaselineHealthCard moved from a top-of-page chip to a full bordered card at the top of the sidebar.
Column labels `[nav]` and `[tasks]` removed entirely.

**Component tree (≥140 cols / sidebarLayout=true):**

```
<ExecuteBody>                            — body.tsx
  <MultiFlowStrip>                       — only when ≥2 sessions
  <HeaderCard>                           — at the top, all widths (title/elapsed/model/status)
  <ImplementLayout>                      — implement-layout.tsx
    <WideLayout>
      <Box flexDirection="row">          — NO column labels
        <Box width={sidebarWidth}>       — sidebarWidth = max(34, round(cols*0.4))
          <ImplementSidebar>
            1. <BaselineHealthCard>      — bordered card, top of sidebar
            2. <ModelMeta>               — generator + evaluator labels (if defined)
            3. <SidebarDivider>
               <SectionHeader Steps />
               <FlowStepsRail />         — suppressMeta, capped at sidebarFlowStepsRows
            4. <SidebarDivider>
               <SectionHeader Tasks />
               <TaskNavList />           — passive minimap, no keyboard capture
            5. <SidebarDivider>
               <TokenBudgetCard>         — bottom-pinned
        <Box flexGrow>                   — main area (3/5)
          <ImplementMainArea>
            <TasksPanelHost />           — sole input owner
  <Section "Recent log">
  <LogPanel />
  <ResultFooter />
  <CancelScopeOverlay />
```

**Width formula:**

```
sidebarWidth = Math.max(34, Math.round(columns * 0.4))
// 140 cols → 56, 200 cols → 80, 240 cols → 96
// No upper cap — genuine 2/5 split at all widths
```

**Where each piece of meta lives:**

- Sprint title, status, elapsed → `HeaderCard` (above the column split, all widths)
- Generator + evaluator models → `ModelMeta` block inside sidebar (below BaselineHealthCard)
- Baseline health (setup/pre/post/attrib) → `BaselineHealthCard` in sidebar (section 1)
- Task minimap → `TaskNavList` in sidebar (section 3)
- Flow steps → `FlowStepsRail` in sidebar (section 2)
- Token summary → `TokenBudgetCard` in sidebar (section 4, bottom)

**Height budget (use-responsive-layout.ts):**

```
PAGE_CHROME_ROWS = 10      // HeaderCard + ViewShell + log chrome + footer
SIDEBAR_CHROME_ROWS = 20   // BaselineCard(7) + Steps/Tasks headers + dividers + gutters + TokenBudgetCard(5)
logRows = 6 (running) / 10 (done)
sidebarBodyRows = max(0, rows - PAGE_CHROME_ROWS - SIDEBAR_CHROME_ROWS - logRows)
sidebarFlowStepsRows = min(10, max(0, floor(sidebarBodyRows * 0.35)))
sidebarTaskNavRows = max(4, sidebarBodyRows - sidebarFlowStepsRows)
```

On a 50-row terminal: bodyRows = 50 - 10 - 20 - 6 = 14 → steps=4, taskNav=10.
On a 60-row terminal: bodyRows = 60 - 10 - 20 - 6 = 24 → steps=8, taskNav=16.
Tight terminals (35 rows): bodyRows may be 0; task-nav stays at minimum 4.

**Model meta rendering (ModelMeta component in implement-sidebar.tsx):**

- Both models defined and EQUAL → single `model <x>` line
- Both defined but DIFFER → two lines: `generator <x>` + `evaluator <y>`
- One or both undefined → omit the missing line
- Uses `<Box><Text dimColor>generator</Text><Text> </Text><Text>{model}</Text></Box>` pattern

**Token honesty rules (token-budget-card.tsx):**

1. **Cumulative detection**: `isCumulative = totalUsed > contextWindow`. When true:
   - Show `session: N (cumulative)` via `<Text><Text dimColor>session:</Text>{' N '}<Text dimColor>(cumulative)</Text></Text>`
   - NO bar or percentage
   - Prevents absurd "2.2M / 200k 100%" display from claude -p cumulative data

2. **Cache-hit formula**: `cacheRead / (cacheRead + input)` — always 0–100%.

3. **Label spacing invariant**: use single outer `<Text>` with nested `<Text>` for colour.
   Do NOT use sibling Text nodes in a Box for label+value (Ink gives each 50% flex width → wraps).
   Do NOT rely on trailing spaces inside styled Text nodes (Ink collapses them).

**Why:** User found the old sidebar cluttered (chip on page, wrong order, fake context bar).
The bordered baseline card + model meta block gives full visibility into the harness configuration
without a separate StatusBand row.

**How to apply:** When adding new per-run meta, put it in the BaselineHealthCard or ModelMeta
block. Keep `ImplementSidebar` sections in order: Baseline → Steps → Tasks → Tokens.
The test `visual-verification.test.tsx` asserts all six visual invariants.
