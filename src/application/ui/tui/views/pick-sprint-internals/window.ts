/**
 * Cursor-centred row windowing for the pick-sprint picker.
 *
 * The picker shows a cross-project list that can run to hundreds of rows; rendering the full
 * list violates the `slice-before-map` mandate and degrades Ink reconciliation. `computeWindow`
 * is a pure helper that picks the visible slice; the orchestrator memoises the call against
 * `rows`, `cursor`, `visible`.
 *
 * The `computeWindow` symbol is re-exported from `pick-sprint-view.tsx` so the unit-test
 * import (`@src/application/ui/tui/views/pick-sprint-view.tsx`) keeps working without churn.
 */

/**
 * Vertical chrome the picker reserves above + below the row list: title bar (≈3), subtitle (1),
 * summary header + spacing (≈3), footer hint (≈2), scroll indicators (≈2), bottom margin (≈1).
 * The window slice consumes `terminalRows - VERTICAL_CHROME_ROWS`, bounded by
 * {@link MIN_VISIBLE_ROWS} so very short terminals still render a usable list.
 */
export const VERTICAL_CHROME_ROWS = 12;
export const MIN_VISIBLE_ROWS = 8;

export interface RowWindow {
  readonly start: number;
  readonly end: number;
  readonly hiddenAbove: number;
  readonly hiddenBelow: number;
}

/**
 * Compute a cursor-centred slice of the flat row list. Keeps the focused row near the middle of
 * the window so the user always sees one screen of context above and below. Clamps to row-list
 * bounds; if total rows fit within `visible`, returns the full list with no overflow indicators.
 *
 * Defined as a pure function (test-friendly).
 */
export const computeWindow = (totalRows: number, cursor: number, visible: number): RowWindow => {
  if (totalRows <= visible) return { start: 0, end: totalRows, hiddenAbove: 0, hiddenBelow: 0 };
  const half = Math.floor(visible / 2);
  let start = Math.max(0, cursor - half);
  let end = start + visible;
  if (end > totalRows) {
    end = totalRows;
    start = Math.max(0, end - visible);
  }
  return { start, end, hiddenAbove: start, hiddenBelow: totalRows - end };
};
