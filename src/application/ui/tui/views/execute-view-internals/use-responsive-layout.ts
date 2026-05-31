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

import { CONTEXT_WIDTH, fluid, RAIL_WIDTH, resolveRailWidth } from '@src/application/ui/tui/theme/tokens.ts';

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
  readonly logRows: number;
  readonly threeColRailWidth: number;
  readonly labelledRailWidth: number;
  readonly contextWidth: number;
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

  // The two-column branch uses the fixed `RAIL_WIDTH`; the three-column branch grows the
  // rail fluidly. We compute once and reuse so the truncation budget passed to StepTrace
  // matches whichever column actually renders.
  const threeColRailWidth = resolveRailWidth(columns);
  const labelledRailWidth = threeColumn ? threeColRailWidth : RAIL_WIDTH;
  // Context column grows slightly at xxl so the baseline card has a little more breathing room.
  const contextWidth = fluid(columns, { min: CONTEXT_WIDTH, max: 36, ratio: 0.14 });

  return {
    threeColumn,
    twoColumn,
    compactTwoColumn,
    singleColumn,
    flowStepsRows,
    tasksMaxSignals,
    logRows,
    threeColRailWidth,
    labelledRailWidth,
    contextWidth,
  };
};
