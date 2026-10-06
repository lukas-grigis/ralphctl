/**
 * Per-task step tree inside an expanded card: Prepare / Attempt n/N / Round n/N / Verify / Commit /
 * Finish, drawn by the same row renderer as the flow-level tree. Replaces the flat sub-step list
 * and the colour-only generator/evaluator dots — the running round row carries its own spinner.
 */

import React from 'react';
import type { StepView } from '@src/application/ui/tui/runtime/flow-progress.ts';
import { StepRowsWindow, stepDisplayRows } from '@src/application/ui/tui/components/flow-steps-tree.tsx';

export interface TaskStepTreeProps {
  /** The task's work-item root; its children are the rows. */
  readonly view: StepView;
  /** Row budget for the whole tree, overflow cues included. */
  readonly maxRows: number;
  /** The run is over, so a failed row (not the running one) anchors the window. */
  readonly settled: boolean;
  readonly running: boolean;
}

export const TaskStepTree = ({ view, maxRows, settled, running }: TaskStepTreeProps): React.JSX.Element | null => (
  <StepRowsWindow rows={stepDisplayRows(view.children)} maxRows={maxRows} settled={settled} spin={running} />
);
