/**
 * Width regimes and row/column budgets for the Execute view — a pure function of terminal size.
 *
 *   ≥140 (lg+)  : sidebar layout (`ImplementLayout`); side-by-side context cards at ≥180 (xl).
 *   100–139 (md): compact — full-width Tasks (or Steps tree); the header strip carries the main steps.
 *   <100        : single-column stack.
 */

import { breakpoints } from '@src/application/ui/tui/theme/tokens.ts';

const NARROW_FLOW_STEPS_ROWS = 4;

/**
 * Fixed chrome rows around the main region: header card (incl. step strip), ViewShell banner,
 * log section chrome, ResultFooter, margins.
 */
const PAGE_CHROME_ROWS = 11;
/** Fixed rows of the active task card above its step tree: kinds bar, notes, header, criteria, verdict slot. */
const TASK_CARD_FIXED_ROWS = 14;
/** Sidebar chrome: BaselineHealthCard (~7) + Steps/Tasks headers, dividers, gutters + TokenBudgetCard (~5). */
const SIDEBAR_CHROME_ROWS = 20;
const SIDEBAR_STEPS_CAP = 10;
/** Floor for the sidebar steps tree; the minimap gives the rows up. */
const SIDEBAR_STEPS_MIN = 3;
const SIDEBAR_TASK_NAV_MIN = 4;

export interface ResponsiveLayout {
  readonly compactTwoColumn: boolean;
  readonly singleColumn: boolean;
  readonly flowStepsRows: number;
  readonly tasksMaxSignals: number;
  /**
   * Card-count budget for the Tasks column (cards, not rows — they are variable-height); the
   * anchored window hides the rest behind an "N more" cue so the log + footer stay on-screen.
   */
  readonly tasksMaxBlocks: number;
  /** Row budget for one task's step tree; the window stays anchored on the running row. */
  readonly taskStepTreeRows: number;
  /** Rows for a full-height Steps tree that replaces the Tasks panel in flows without task work items. */
  readonly stepsMainRows: number;
  readonly logRows: number;
  /** True at ≥140 cols — the sidebar layout renders. */
  readonly sidebarLayout: boolean;
  /** 2/5 of the terminal width, floored at 34. */
  readonly sidebarWidth: number;
  /** Visible task-nav rows in the sidebar minimap (floored at 4). */
  readonly sidebarTaskNavRows: number;
  /** Max rows for the sidebar steps tree (3..10); the minimap gets the rest of the shared body budget. */
  readonly sidebarFlowStepsRows: number;
  /** Rows left for the sidebar body (task-nav + steps) after fixed chrome; ImplementSidebar hard-caps its height on it. */
  readonly sidebarBodyRows: number;
  /** ≥xl: sidebar is wide enough (~72) for BaselineHealthCard and TokenBudgetCard side by side; below, they stack. */
  readonly sidebarContextSideBySide: boolean;
}

interface ResponsiveLayoutInput {
  readonly columns: number;
  readonly rows: number;
  readonly isRunning: boolean;
}

export const resolveResponsiveLayout = ({ columns, rows, isRunning }: ResponsiveLayoutInput): ResponsiveLayout => {
  const sidebarLayout = columns >= breakpoints.lg;
  const compactTwoColumn = columns >= breakpoints.md;
  const singleColumn = !compactTwoColumn;

  const flowStepsRows = singleColumn ? NARROW_FLOW_STEPS_ROWS : isRunning ? Math.max(8, rows - 22) : 16;
  const tasksMaxSignals = isRunning ? 6 : 12;
  // Floor of 6 keeps small terminals safe; the caps keep the log from starving the sidebar budgets.
  const logRows = isRunning ? Math.max(6, Math.min(16, rows - 38)) : Math.max(6, Math.min(18, rows - 36));
  const sidebarWidth = Math.max(34, Math.round(columns * 0.4));

  // ~3-4 rows/card is deliberately conservative; the anchored window keeps the active card visible anyway.
  const tasksMaxBlocks = singleColumn
    ? Math.max(2, Math.floor((rows - NARROW_FLOW_STEPS_ROWS - 10) / 4))
    : sidebarLayout
      ? Math.max(3, Math.floor((rows - PAGE_CHROME_ROWS - logRows) / 3))
      : Math.max(3, Math.floor((rows - 14) / 4));

  const mainRows = singleColumn ? rows - NARROW_FLOW_STEPS_ROWS - PAGE_CHROME_ROWS : rows - PAGE_CHROME_ROWS - logRows;
  const taskStepTreeRows = Math.min(16, Math.max(5, mainRows - TASK_CARD_FIXED_ROWS));
  const stepsMainRows = Math.max(NARROW_FLOW_STEPS_ROWS, mainRows - 2);

  const sidebarBodyRows = Math.max(0, rows - PAGE_CHROME_ROWS - SIDEBAR_CHROME_ROWS - logRows);
  const sidebarFlowStepsRows = Math.min(
    SIDEBAR_STEPS_CAP,
    Math.max(SIDEBAR_STEPS_MIN, Math.floor(sidebarBodyRows * 0.35))
  );
  const sidebarTaskNavRows = Math.max(SIDEBAR_TASK_NAV_MIN, sidebarBodyRows - sidebarFlowStepsRows);

  return {
    compactTwoColumn,
    singleColumn,
    flowStepsRows,
    tasksMaxSignals,
    tasksMaxBlocks,
    taskStepTreeRows,
    stepsMainRows,
    logRows,
    sidebarLayout,
    sidebarWidth,
    sidebarTaskNavRows,
    sidebarFlowStepsRows,
    sidebarBodyRows,
    sidebarContextSideBySide: columns >= breakpoints.xl,
  };
};
