/**
 * Footer of the execute view — renders a settled-run `ResultCard` (completed / aborted /
 * failed) once the session is no longer live. While the run is still running the footer
 * renders nothing — the header card already shows `[RUNNING]` with its own live spinner.
 * Pure presentational; the orchestrator decides which descriptor / counts / elapsed string
 * to feed in.
 */

import React from 'react';
import { Box } from 'ink';
import { ResultCard } from '@src/application/ui/tui/components/result-card.tsx';
import { spacing } from '@src/application/ui/tui/theme/tokens.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';

interface ResultFooterProps {
  readonly descriptor: SessionDescriptor;
  readonly isRunning: boolean;
  readonly tasksDone: number;
  readonly tasksTotal: number;
  readonly elapsed: string;
}

const ResultFooterImpl = ({
  descriptor,
  isRunning,
  tasksDone,
  tasksTotal,
  elapsed,
}: ResultFooterProps): React.JSX.Element | null => {
  if (isRunning) {
    // Header card already shows [RUNNING] + live spinner — no redundant footer needed.
    return null;
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

// Memoized: renders null while running (the common, tick-driven case) and `elapsed` stops
// changing the instant `descriptor.finishedAt` is set, so this component's props are stable
// both before and after settle — memo just skips the redundant re-render on every tick.
export const ResultFooter = React.memo(ResultFooterImpl);
