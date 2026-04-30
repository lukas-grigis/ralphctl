/**
 * SprintSummaryLine — a single-line summary of the current sprint shown on Home.
 *
 * Format: [STATUS]  Name  ·  N tickets · M tasks (X done)  ·  branch <name>
 *
 * When no current sprint is configured, renders "No current sprint set." in
 * muted color.
 *
 * Receives data directly (no async I/O) — the parent view is responsible for
 * loading and passing the sprint snapshot. This keeps the component pure and
 * easy to test.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors, spacing } from '../../../integration/ui/theme/tokens.ts';
import { StatusChip, chipKindForSprintStatus } from './status-chip.tsx';

export interface SprintSummaryData {
  readonly name: string;
  readonly status: 'draft' | 'active' | 'closed';
  readonly ticketCount: number;
  readonly taskCount: number;
  readonly tasksDone: number;
  readonly branch?: string | null;
}

interface Props {
  readonly data: SprintSummaryData | null;
}

function dot(): React.JSX.Element {
  return <Text dimColor>{`  ${glyphs.inlineDot}  `}</Text>;
}

export function SprintSummaryLine({ data }: Props): React.JSX.Element {
  if (data === null) {
    return (
      <Box>
        <Text dimColor>No current sprint set.</Text>
      </Box>
    );
  }

  const taskPart =
    data.taskCount > 0
      ? `${String(data.taskCount)} task${data.taskCount !== 1 ? 's' : ''} (${String(data.tasksDone)} done)`
      : `${String(data.taskCount)} task${data.taskCount !== 1 ? 's' : ''}`;

  return (
    <Box flexWrap="wrap">
      <StatusChip label={data.status} kind={chipKindForSprintStatus(data.status)} />
      <Box marginLeft={spacing.indent}>
        <Text bold>{data.name}</Text>
      </Box>
      {dot()}
      <Text dimColor>{`${String(data.ticketCount)} ticket${data.ticketCount !== 1 ? 's' : ''}`}</Text>
      {dot()}
      <Text dimColor>{taskPart}</Text>
      {data.branch != null && data.branch !== '' ? (
        <>
          {dot()}
          <Text color={inkColors.info} dimColor>
            {`branch ${data.branch}`}
          </Text>
        </>
      ) : null}
    </Box>
  );
}
