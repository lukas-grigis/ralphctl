/**
 * Flow-steps rail — the step tree of a session's flow-progress projection, used wherever the
 * Execute view shows main steps as a list (sidebar, a full-width Steps section, or the main
 * column of a flow without task work items). The projection is computed once upstream and handed
 * in, so every surface reads the same rows and a live step event re-renders the tree even though
 * the session descriptor keeps one reference for the whole run.
 */

import React from 'react';
import { FlowStepsTree } from '@src/application/ui/tui/components/flow-steps-tree.tsx';
import type { FlowProgress } from '@src/application/ui/tui/runtime/flow-progress.ts';

interface RailProps {
  readonly progress: FlowProgress | undefined;
  readonly isRunning: boolean;
  readonly maxRows: number;
  /** Column budget — rows truncate with an ellipsis rather than wrapping. */
  readonly railWidth: number;
}

export const FlowStepsRail = ({ progress, isRunning, maxRows, railWidth }: RailProps): React.JSX.Element | null =>
  progress === undefined ? null : (
    <FlowStepsTree
      spine={progress.spine}
      maxRows={maxRows}
      settled={!isRunning}
      running={isRunning}
      width={railWidth}
    />
  );
