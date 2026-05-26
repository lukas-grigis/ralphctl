/**
 * Footer of the execute view — renders either a settled-run `ResultCard` (completed /
 * aborted / failed) or, while the run is still live, a `running…` spinner. Pure
 * presentational; the orchestrator decides which descriptor / counts / elapsed string to
 * feed in.
 */

import React from 'react';
import { Box } from 'ink';
import { ResultCard } from '@src/application/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { spacing } from '@src/application/ui/tui/theme/tokens.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';

interface ResultFooterProps {
  readonly descriptor: SessionDescriptor;
  readonly isRunning: boolean;
  readonly tasksDone: number;
  readonly tasksTotal: number;
  readonly elapsed: string;
}

export const ResultFooter = ({
  descriptor,
  isRunning,
  tasksDone,
  tasksTotal,
  elapsed,
}: ResultFooterProps): React.JSX.Element => {
  if (isRunning) {
    return (
      <Box paddingX={spacing.indent} marginTop={spacing.section}>
        <Spinner label="running…" />
      </Box>
    );
  }
  return (
    <Box marginTop={spacing.section}>
      <ResultCard
        kind={descriptor.status === 'completed' ? 'success' : descriptor.status === 'aborted' ? 'aborted' : 'failed'}
        title={descriptor.title}
        summary={descriptor.error?.message}
        fields={[
          { label: 'Status', value: descriptor.status },
          { label: 'Steps', value: String(descriptor.trace.length) },
          { label: 'Tasks', value: `${String(tasksDone)}/${String(tasksTotal)}` },
          { label: 'Elapsed', value: elapsed },
        ]}
      />
    </Box>
  );
};
