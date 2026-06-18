---
name: project_implement_view_band_layout
description: Status band + navigation sidebar layout redesign for the Implement view — component tree, height budget, token honesty rules (Jun 2026)
metadata:
  type: project
---

## Decision

v0.7.0 layout overhaul: replaced the cluttered multi-panel sidebar with a "status band + focus" structure.

**Component tree (≥140 cols / sidebarLayout):**

```
<ExecuteBody>                          — body.tsx (wide: no HeaderCard/BaselineHealthChip)
  <MultiFlowStrip>                     — only when ≥2 sessions
  <ImplementLayout>                    — implement-layout.tsx
    <WideLayout>
      <StatusBand>                     — NEW: 1-row horizontal chrome
      <Box flexDirection="row">
        <Box width={sidebarWidth}>
          <ColumnLabel label="nav" />
          <ImplementSidebar>           — navigation only (no meta/baseline/tokens)
            <SectionHeader Tasks />
            <TaskNavList />            — passive minimap
            <SidebarDivider />
            <SectionHeader Steps />
            <FlowStepsRail />
        <Box flexGrow>
          <ColumnLabel label="tasks" />
          <ImplementMainArea>
            <TasksPanelHost />
    <Section "Recent log">
    <LogPanel />
    <ResultFooter />
    <CancelScopeOverlay />
```

**Where each piece of meta lives now:**

- Sprint label, status, elapsed, model pair → `StatusBand` (top)
- Baseline health (compact: glyph + tier) → `StatusBand`
- Token summary (compact: `tok N` / `ctx N/window (%)`) → `StatusBand`
- Task minimap + flow steps → `ImplementSidebar` (left column, nav-only)
- Active task card (rich: attempt/round, gen●/eval●, substeps, eval verdict) → `ImplementMainArea`

**Height budget (use-responsive-layout.ts):**

```
PAGE_CHROME_ROWS = 8       // status band + column labels + log section chrome + footer
SIDEBAR_CHROME_ROWS = 5    // Tasks header + Steps header + dividers + gutters
logRows = 6 (running) / 10 (done)
sidebarBodyRows = rows - PAGE_CHROME_ROWS - SIDEBAR_CHROME_ROWS - logRows
sidebarFlowStepsRows = min(10, max(0, floor(sidebarBodyRows * 0.35)))
sidebarTaskNavRows = max(4, sidebarBodyRows - sidebarFlowStepsRows)
```

**Token honesty rules (token-budget-card.tsx + status-band.tsx):**

1. **Cumulative detection**: `isCumulative = totalUsed > contextWindow`. When true, show `tok N cumul.` with NO bar or percentage. Prevents absurd "2.2M / 200k 100%" display from claude -p cumulative data.

2. **Cache-hit formula**: `cacheRead / (cacheRead + input)` — always 0–100%. Never `cacheTotal / input` (could produce 9176567%).

3. **Label spacing**: use `<Text>` wrapper with inner `<Text dimColor>label:</Text>{' '}value` pattern. Do NOT rely on trailing spaces inside styled Text nodes (Ink collapses them). Do NOT use sibling Text nodes in a Box for label+value (Ink gives each 50% flex width → wraps). Use single outer `<Text>` with nested `<Text>` for color.

**Why:** User found the old sidebar cluttered (18 chrome rows consumed by meta). Status band consumes 1 row total. Sidebar now gives all its space to task minimap + steps.

**How to apply:** When adding new meta to the wide implement view, put it in StatusBand. Keep ImplementSidebar navigation-only.
