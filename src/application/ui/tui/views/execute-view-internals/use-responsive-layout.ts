/**
 * Resolves the four width regimes the execute view supports — three-column / two-column / compact-two / single.
 */

import {
  breakpoints,
  CONTEXT_WIDTH,
  fluid,
  RAIL_WIDTH,
  resolveRailWidth,
} from '@src/application/ui/tui/theme/tokens.ts';

const NARROW_FLOW_STEPS_ROWS = 4;
/** Rows the settled `ResultFooter` (card border + title + fields + next steps) claims from the body. */
export const SETTLED_FOOTER_ROWS = 10;

export interface ResponsiveLayout {
  readonly threeColumn: boolean;
  readonly twoColumn: boolean;
  readonly compactTwoColumn: boolean;
  readonly singleColumn: boolean;
  readonly flowStepsRows: number;
  readonly tasksMaxSignals: number;
  /**
   * Card-count budget for the Tasks column — how many task cards the middle column may render before the anchored
   * window ({@link computeAnchoredWindow}) hides the rest behind an "N more" cue.
   */
  readonly tasksMaxBlocks: number;
  readonly logRows: number;
  readonly threeColRailWidth: number;
  readonly labelledRailWidth: number;
  readonly contextWidth: number;
  /** True at ≥140 cols — the redesigned Implement view renders its left sidebar. */
  readonly sidebarLayout: boolean;
  /** Fluid sidebar width — grows with the terminal, clamped to [34, 48]. */
  readonly sidebarWidth: number;
  /** Visible task-nav rows in the sidebar minimap. */
  readonly sidebarTaskNavRows: number;
  /**
   * Max rows for the flow-steps rail inside the sidebar. Derived from the same shared budget as {@link
   * sidebarTaskNavRows}.
   */
  readonly sidebarFlowStepsRows: number;
  /**
   * Rows available for the sidebar body (task-nav + flow-steps combined), after subtracting the fixed chrome rows.
   */
  readonly sidebarBodyRows: number;
  /**
   * True when the sidebar is wide enough to render `BaselineHealthCard` and `TokenBudgetCard` side by side (each
   * `CONTEXT_WIDTH` cols wide).
   */
  readonly sidebarContextSideBySide: boolean;
}

interface UseResponsiveLayoutInput {
  readonly columns: number;
  readonly rows: number;
  readonly isRunning: boolean;
}

export const useResponsiveLayout = ({ columns, rows, isRunning }: UseResponsiveLayoutInput): ResponsiveLayout => {
  const threeColumn = columns >= breakpoints.xl;
  const twoColumn = !threeColumn && columns >= breakpoints.lg;
  /*
   * Below `md` the Flow Steps section collapses to four rows in single-column mode AND
   * the two-column layout disappears entirely (we never render the rail on a <100 col terminal
   * — the stream column wouldn't have room left). At 100-139 cols a *compact* rail variant
   * (status glyphs only, no labels) is rendered instead of the labelled rail used at ≥140 cols.
   */
  const compactTwoColumn = !threeColumn && !twoColumn && columns >= breakpoints.md;
  const singleColumn = !threeColumn && !twoColumn && !compactTwoColumn;

  const baseFlowStepsRows = isRunning ? Math.max(8, rows - 22) : 16;
  const flowStepsRows = singleColumn ? NARROW_FLOW_STEPS_ROWS : baseFlowStepsRows;
  const tasksMaxSignals = isRunning ? 6 : 12;
  // Scale logRows with terminal height so the Recent-events panel fills available space rather than leaving a large
  // empty gap on tall terminals.
  const logRows = isRunning
    ? Math.max(6, Math.min(16, rows - 38))
    : Math.max(6, Math.min(18, rows - 36 - SETTLED_FOOTER_ROWS));

  // Sidebar layout gate — same ≥140 threshold as the two-column rail.
  const sidebarLayout = columns >= breakpoints.lg;
  // 2/5 of terminal width — gives the sidebar room for the baseline card (which can be wide), task names, and
  // flow-step labels; the main area (flexGrow) keeps the remaining 3/5.
  const sidebarWidth = Math.max(34, Math.round(columns * 0.4));

  // Card budget for the Tasks column.
  const PAGE_CHROME_ROWS = 10; // header-card + ViewShell + log chrome + footer

  const reserved = isRunning ? 0 : SETTLED_FOOTER_ROWS;
  const tasksMaxBlocks = singleColumn
    ? Math.max(2, Math.floor((rows - reserved - NARROW_FLOW_STEPS_ROWS - 10) / 4))
    : sidebarLayout
      ? Math.max(3, Math.floor((rows - reserved - PAGE_CHROME_ROWS - logRows) / 3))
      : Math.max(3, Math.floor((rows - reserved - 14) / 4));

  // The two-column branch uses the fixed `RAIL_WIDTH`; the three-column branch grows the rail fluidly.
  const threeColRailWidth = resolveRailWidth(columns);
  const labelledRailWidth = threeColumn ? threeColRailWidth : RAIL_WIDTH;
  // Context column grows slightly at xxl so the baseline card has a little more breathing room.
  const contextWidth = fluid(columns, { min: CONTEXT_WIDTH, max: 36, ratio: 0.14 });

  // The redesigned wide layout (≥140 cols) stacks: multiflow-strip(≤1) + HeaderCard(~4) + [sidebar|main] +
  // recentLog(logRows + 2 section chrome) + ResultFooter(1) BaselineHealthChip removed from page.

  const SIDEBAR_CHROME_ROWS = 20; // BaselineCard + Steps/Tasks headers + dividers + gutters + TokenBudgetCard
  const SIDEBAR_STEPS_CAP = 10; // max rows for the flow-steps rail in sidebar
  const SIDEBAR_TASK_NAV_MIN = 4; // minimum rows for the task-nav minimap

  const sidebarBodyRows = Math.max(0, rows - PAGE_CHROME_ROWS - SIDEBAR_CHROME_ROWS - logRows);
  // Split: steps get up to STEPS_CAP, task-nav gets the remainder (minimum TASK_NAV_MIN each).
  const sidebarFlowStepsRows = Math.min(SIDEBAR_STEPS_CAP, Math.max(0, Math.floor(sidebarBodyRows * 0.35)));
  const sidebarTaskNavRows = Math.max(SIDEBAR_TASK_NAV_MIN, sidebarBodyRows - sidebarFlowStepsRows);

  // Side-by-side context cards: true at ≥xl (180 cols) where sidebarWidth ≥ 72, giving each CONTEXT_WIDTH (28) card
  // 28 cols with room to spare.
  const sidebarContextSideBySide = columns >= breakpoints.xl;

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
    sidebarContextSideBySide,
  };
};
