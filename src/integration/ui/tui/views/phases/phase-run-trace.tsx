/**
 * PhaseRunTrace — shared widget rendering the `StepExecutionRecord[]` from a
 * `executePipeline(...)` call. Used by the static phase detail views to show
 * the last run's step-by-step timing + status.
 *
 * Empty list → dim "(no runs yet)" placeholder. Non-empty → one row per
 * step: glyph · step name · duration. Failed steps additionally render the
 * error message on a wrapped second line.
 *
 * Intentionally separate from `LogTail` (log events) and the live-streaming
 * pane (AI stdout) so Commit C can layer those on top without reworking this.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { StepExecutionRecord } from '@src/business/pipelines/framework/types.ts';
import { inkColors } from '@src/integration/ui/theme/tokens.ts';

interface Props {
  readonly records: readonly StepExecutionRecord[];
  /** Optional title rendered above the trace; defaults to "Last run". */
  readonly title?: string;
}

const STATUS_GLYPH: Record<StepExecutionRecord['status'], string> = {
  success: '✓',
  skipped: '·',
  failed: '✗',
};

const STATUS_COLOR: Record<StepExecutionRecord['status'], string> = {
  success: inkColors.success,
  skipped: inkColors.muted,
  failed: inkColors.error,
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${String(mins)}m${String(secs).padStart(2, '0')}s`;
}

export function PhaseRunTrace({ records, title = 'Last run' }: Props): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor bold>
          {title}
        </Text>
      </Box>
      {records.length === 0 ? (
        <Box paddingLeft={2}>
          <Text dimColor>(no runs yet)</Text>
        </Box>
      ) : (
        records.map((r, i) => (
          <Box key={`${r.stepName}-${String(i)}`} flexDirection="column" paddingLeft={2}>
            <Box>
              <Text color={STATUS_COLOR[r.status]} bold>
                {STATUS_GLYPH[r.status]}
              </Text>
              <Text>{` ${r.stepName}  `}</Text>
              <Text dimColor>{formatDuration(r.durationMs)}</Text>
            </Box>
            {r.error ? (
              <Box paddingLeft={2}>
                <Text color={inkColors.error}>↳ {r.error.message}</Text>
              </Box>
            ) : null}
          </Box>
        ))
      )}
    </Box>
  );
}
