/**
 * While the run is still running the footer renders nothing — the header card already shows `[RUNNING]` with its own
 * live spinner.
 */

import React from 'react';
import { Box } from 'ink';
import { ResultCard } from '@src/application/ui/tui/components/result-card.tsx';
import { glyphs, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { NextSteps } from '@src/application/ui/shared/next-steps.ts';

interface ResultFooterProps {
  readonly descriptor: SessionDescriptor;
  readonly isRunning: boolean;
  readonly tasksDone: number;
  readonly tasksTotal: number;
  readonly elapsed: string;
  /** What the operator should do next, plus the post-mortem paths a failure left behind. */
  readonly nextSteps: NextSteps;
}

/** Caps for the three variable-length blocks of the settled card. */
const MAX_SUMMARY_LINES = 3;
const MAX_SUMMARY_CHARS = 240;
const MAX_NEXT_STEPS = 4;
const MAX_FORENSICS = 5;

/**
 * Clip the error summary to a bounded row footprint: at most {@link MAX_SUMMARY_LINES} lines and {@link
 * MAX_SUMMARY_CHARS} characters (the char cap bounds Ink's soft wrap.
 */
const clipSummary = (summary: string | undefined): string | undefined => {
  if (summary === undefined) return undefined;
  const lines = summary.split('\n');
  const head = lines.slice(0, MAX_SUMMARY_LINES).join('\n');
  const body = head.slice(0, MAX_SUMMARY_CHARS);
  const clipped = lines.length > MAX_SUMMARY_LINES || head.length > MAX_SUMMARY_CHARS;
  return clipped ? `${body.trimEnd()}${glyphs.clipEllipsis}` : body;
};

const ResultFooterImpl = ({
  descriptor,
  isRunning,
  tasksDone,
  tasksTotal,
  elapsed,
  nextSteps,
}: ResultFooterProps): React.JSX.Element | null => {
  if (isRunning) {
    // Header card already shows [RUNNING] + live spinner — no redundant footer needed.
    return null;
  }
  return (
    <Box flexDirection="column" marginTop={spacing.section}>
      <ResultCard
        kind={descriptor.status === 'completed' ? 'success' : descriptor.status === 'aborted' ? 'aborted' : 'failed'}
        title={descriptor.title}
        summary={clipSummary(descriptor.error?.message)}
        fields={[
          { label: 'Status', value: descriptor.status },
          { label: 'Steps', value: String(descriptor.trace.length) },
          { label: 'Tasks', value: `${String(tasksDone)}/${String(tasksTotal)}` },
          { label: 'Elapsed', value: elapsed },
        ]}
        nextSteps={nextSteps.steps.slice(0, MAX_NEXT_STEPS)}
        forensics={nextSteps.forensics.slice(0, MAX_FORENSICS)}
      />
    </Box>
  );
};

// Memoized: renders null while running (the common, tick-driven case) and `elapsed` stops changing the instant
// `descriptor.finishedAt` is set.
export const ResultFooter = React.memo(ResultFooterImpl);
