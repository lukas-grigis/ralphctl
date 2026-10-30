/**
 * Narrow (<140 cols) composition of the execute view's main body; ≥140 cols is owned by
 * `ImplementLayout` (see body.tsx).
 *
 *   100–139 cols:  compact — full-width Tasks; the header strip carries the main steps. A
 *                  flow without task work items shows a full-width Steps tree instead.
 *   <100 cols:     single-column stack — Tasks (or Steps, without task work items) section.
 *
 * `width={termColumns}` on the compact row is load-bearing: without it the row inherits its
 * intrinsic content width and the flexGrow column resolves against an un-budgeted parent.
 */

import React from 'react';
import { Box } from 'ink';
import { spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { Section, SectionHeader } from '@src/application/ui/tui/views/execute-view-internals/section.tsx';
import { FlowStepsRail } from '@src/application/ui/tui/views/execute-view-internals/rail.tsx';
import type { FlowProgress } from '@src/application/ui/tui/runtime/flow-progress.ts';

interface LayoutProps {
  readonly progress: FlowProgress | undefined;
  readonly isRunning: boolean;
  readonly termColumns: number;
  readonly flowStepsRows: number;
  readonly compactTwoColumn: boolean;
  readonly tasksPanel: React.ReactNode;
}

export const ExecuteLayout = ({
  progress,
  isRunning,
  termColumns,
  flowStepsRows,
  compactTwoColumn,
  tasksPanel,
}: LayoutProps): React.JSX.Element => {
  // Flows without task work items have nothing for a Tasks panel to show: their steps take its place.
  const stepsInPlaceOfTasks = progress !== undefined && !progress.hasTaskWorkItems;
  const steps = (
    <FlowStepsRail progress={progress} isRunning={isRunning} maxRows={flowStepsRows} railWidth={termColumns - 4} />
  );

  if (compactTwoColumn) {
    return (
      <Box flexDirection="row" marginTop={spacing.section} width={termColumns}>
        <Box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0}>
          <SectionHeader title={stepsInPlaceOfTasks ? 'Steps' : 'Tasks'} />
          {stepsInPlaceOfTasks ? steps : tasksPanel}
        </Box>
      </Box>
    );
  }
  return stepsInPlaceOfTasks ? <Section title="Steps">{steps}</Section> : <Section title="Tasks">{tasksPanel}</Section>;
};
