/**
 * Resolves the four width regimes the execute view supports — three-column / two-column /
 * compact-two / single — into a single readonly record alongside the derived row caps and
 * column widths every regime needs.
 *
 *   ≥180 cols (xl+):  three-column — fluid-width rail + flex Tasks + fixed context column.
 *   140–179 cols   :  two-column — fixed RAIL_WIDTH rail + flex Tasks.
 *   100–139 cols   :  compact two-column — glyph-only rail.
 *   <100 cols      :  single-column stack.
 *
 * Pulling the breakpoint logic out of the view keeps the orchestrator focused on hook
 * composition rather than width arithmetic.
 */

import {
  CONTEXT_WIDTH,
  fluid,
  RAIL_WIDTH,
  resolveRailWidth,
  SIDEBAR_WIDTH,
} from '@src/application/ui/tui/theme/tokens.ts';

const TWO_COL_BREAKPOINT = 140;
const THREE_COL_BREAKPOINT = 180;
/**
 * Below this width the Flow Steps section collapses to four rows in single-column mode AND
 * the two-column layout disappears entirely (we never render the rail on a <100 col terminal
 * — the stream column wouldn't have room left). At 100-139 cols a *compact* rail variant
 * (status glyphs only, no labels) is rendered instead of the labelled rail used at ≥140 cols.
 */
const NARROW_FLOW_STEPS_BREAKPOINT = 100;
const NARROW_FLOW_STEPS_ROWS = 4;

export interface ResponsiveLayout {
  readonly threeColumn: boolean;
  readonly twoColumn: boolean;
  readonly compactTwoColumn: boolean;
  readonly singleColumn: boolean;
  readonly flowStepsRows: number;
  readonly tasksMaxSignals: number;
  /**
   * Card-count budget for the Tasks column — how many task cards the middle column may render
   * before the anchored window ({@link computeAnchoredWindow}) hides the rest behind an
   * "N more" cue. Derived from terminal rows so the column stops growing past the viewport and
   * pushing the Recent-log + footer off-screen. Counts cards, not rows (cards are
   * variable-height; the rail counts the same way).
   */
  readonly tasksMaxBlocks: number;
  readonly logRows: number;
  readonly threeColRailWidth: number;
  readonly labelledRailWidth: number;
  readonly contextWidth: number;
  /** True at ≥140 cols — the redesigned Implement view renders its left sidebar. */
  readonly sidebarLayout: boolean;
  /** Fluid sidebar width — grows with the terminal, clamped to [{@link SIDEBAR_WIDTH}, 36]. */
  readonly sidebarWidth: number;
  /**
   * Visible task-nav rows in the sidebar minimap. Derived from a shared `availableBodyRows`
   * budget that is partitioned among all sidebar sections so the total never exceeds the
   * terminal height. Floored at 4.
   */
  readonly sidebarTaskNavRows: number;
  /**
   * Max rows for the flow-steps rail inside the sidebar. Derived from the same shared budget
   * as {@link sidebarTaskNavRows}. Capped at 10 rows so the task minimap always has breathing
   * room and the TokenBudgetCard is never pushed off-screen.
   */
  readonly sidebarFlowStepsRows: number;
  /**
   * Rows available for the sidebar body (task-nav + flow-steps combined), after subtracting the
   * fixed chrome rows. Exposed so ImplementSidebar can enforce a hard height cap on its Box.
   */
  readonly sidebarBodyRows: number;
}

interface UseResponsiveLayoutInput {
  readonly columns: number;
  readonly rows: number;
  readonly isRunning: boolean;
}

export const useResponsiveLayout = ({ columns, rows, isRunning }: UseResponsiveLayoutInput): ResponsiveLayout => {
  const threeColumn = columns >= THREE_COL_BREAKPOINT;
  const twoColumn = !threeColumn && columns >= TWO_COL_BREAKPOINT;
  const compactTwoColumn = !threeColumn && !twoColumn && columns >= NARROW_FLOW_STEPS_BREAKPOINT;
  const singleColumn = !threeColumn && !twoColumn && !compactTwoColumn;

  const baseFlowStepsRows = isRunning ? Math.max(8, rows - 22) : 16;
  const flowStepsRows = singleColumn ? NARROW_FLOW_STEPS_ROWS : baseFlowStepsRows;
  const tasksMaxSignals = isRunning ? 6 : 12;
  const logRows = isRunning ? 6 : 10;

  // Sidebar layout gate — same ≥140 threshold as the two-column rail.
  // NOTE: <140 cols intentionally falls back to the legacy ExecuteLayout (three/two/compact/single
  // column grid). This is the accepted behaviour for the v0.7.0 redesign gate — do not add a
  // sidebar-only collapse mode for the 100-139 col band without a new design decision.
  const sidebarLayout = columns >= TWO_COL_BREAKPOINT;
  const sidebarWidth = Math.min(36, Math.max(SIDEBAR_WIDTH, Math.round(columns * 0.18)));

  // Card budget for the Tasks column. In single-column the stack also carries the (narrow)
  // Flow-steps + Recent-log, so the Tasks slice is tighter; in multi-column the Tasks column
  // owns the centre and can show more. `~4 rows/card` is a deliberately conservative estimate
  // (a collapsed card is 1-2 rows, the expanded active card is many) — the anchored window
  // keeps the active card visible regardless, so an approximate budget is fine. Floored so a
  // tiny terminal still shows a useful handful.
  //
  // In sidebar layout (≥140 cols) the main area's vertical budget is:
  //   rows - PAGE_CHROME_ROWS(8) - logRows - columnLabel(1) - statusBand(1) = rows - 10 - logRows.
  // Using ~3 rows/card (two-line collapsed + separator) gives a tighter card budget than the
  // legacy `rows - 14 / 4` formula, which was calibrated for the three-column grid (narrower
  // Tasks column with many cards collapsed to 1 row).
  const tasksMaxBlocks = singleColumn
    ? Math.max(2, Math.floor((rows - NARROW_FLOW_STEPS_ROWS - 10) / 4))
    : sidebarLayout
      ? Math.max(3, Math.floor((rows - 10 - logRows) / 3))
      : Math.max(3, Math.floor((rows - 14) / 4));

  // The two-column branch uses the fixed `RAIL_WIDTH`; the three-column branch grows the
  // rail fluidly. We compute once and reuse so the truncation budget passed to StepTrace
  // matches whichever column actually renders.
  const threeColRailWidth = resolveRailWidth(columns);
  const labelledRailWidth = threeColumn ? threeColRailWidth : RAIL_WIDTH;
  // Context column grows slightly at xxl so the baseline card has a little more breathing room.
  const contextWidth = fluid(columns, { min: CONTEXT_WIDTH, max: 36, ratio: 0.14 });

  // ── Sidebar height budget ──────────────────────────────────────────────────
  //
  // The redesigned wide layout (≥140 cols) stacks:
  //   multiflow-strip(≤1) + StatusBand(1) + columnLabels(1) + [sidebar|main] + recentLog(logRows + 2 section chrome) + ResultFooter(1)
  //
  // We treat the fixed page chrome as ~8 rows (conservative — multiflow-strip is conditional).
  //
  // The sidebar is now NAVIGATION ONLY — SprintMeta, BaselineHealthCard and TokenBudgetCard
  // have moved to the StatusBand. The sidebar's own fixed chrome is now just:
  //   "Tasks" header   = 1 row
  //   marginTop gutter = 1 row
  //   "Steps" divider  = 1 row  (only when sidebarFlowStepsRows > 0)
  //   "Steps" header   = 1 row  (only when sidebarFlowStepsRows > 0)
  //   marginTop gutter = 1 row  (only when sidebarFlowStepsRows > 0)
  //   Total fixed chrome: ~2 rows (task-nav only) or ~5 rows (with steps)
  //
  // We use a conservative 5 rows so the splits are never oversubscribed.
  //
  // The REMAINING rows (availableBodyRows) are split between task-nav and flow-steps.
  // We cap flow-steps at 10 and give the rest to task-nav (floor 4), so on a 30-row
  // terminal: bodyRows = 30 - 8(page) - 5(chrome) - 6(log) = 11 → steps=4, taskNav=7.
  // On a 50-row terminal: bodyRows = 50 - 8 - 5 - 6 = 31 → steps=10, taskNav=21.

  const PAGE_CHROME_ROWS = 8; // status band + column labels + log section chrome + footer
  const SIDEBAR_CHROME_ROWS = 5; // Tasks header + Steps header + dividers + gutters
  const SIDEBAR_STEPS_CAP = 10; // max rows for the flow-steps rail in sidebar
  const SIDEBAR_TASK_NAV_MIN = 4; // minimum rows for the task-nav minimap

  const sidebarBodyRows = Math.max(0, rows - PAGE_CHROME_ROWS - SIDEBAR_CHROME_ROWS - logRows);
  // Split: steps get up to STEPS_CAP, task-nav gets the remainder (minimum TASK_NAV_MIN each).
  const sidebarFlowStepsRows = Math.min(SIDEBAR_STEPS_CAP, Math.max(0, Math.floor(sidebarBodyRows * 0.35)));
  const sidebarTaskNavRows = Math.max(SIDEBAR_TASK_NAV_MIN, sidebarBodyRows - sidebarFlowStepsRows);

  return {
    threeColumn,
    twoColumn,
    compactTwoColumn,
    singleColumn,
    flowStepsRows,
    tasksMaxSignals,
    tasksMaxBlocks,
    logRows,
    threeColRailWidth,
    labelledRailWidth,
    contextWidth,
    sidebarLayout,
    sidebarWidth,
    sidebarTaskNavRows,
    sidebarFlowStepsRows,
    sidebarBodyRows,
  };
};
