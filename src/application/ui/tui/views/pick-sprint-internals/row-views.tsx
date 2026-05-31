/**
 * Row presentation for the sprint picker. Pure render components — the orchestrator owns
 * cursor + window state; this file only knows how to draw a given row at a given focus state.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { sprintStatusKind, StatusChip } from '@src/application/ui/tui/components/status-chip.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { FlatRow, HeaderRow } from '@src/application/ui/tui/views/pick-sprint-internals/types.ts';
import { computeWindow } from '@src/application/ui/tui/views/pick-sprint-internals/window.ts';

interface RowWindowViewProps {
  readonly rows: readonly FlatRow[];
  readonly cursor: number;
  readonly visibleRows: number;
  readonly currentSprintId: string | undefined;
}

export const RowWindowView = ({
  rows,
  cursor,
  visibleRows,
  currentSprintId,
}: RowWindowViewProps): React.JSX.Element => {
  const window = useMemo(() => computeWindow(rows.length, cursor, visibleRows), [rows.length, cursor, visibleRows]);
  const slice = rows.slice(window.start, window.end);
  return (
    <Box flexDirection="column">
      {window.hiddenAbove > 0 && (
        <Box paddingX={spacing.indent}>
          <Text dimColor>▲ {String(window.hiddenAbove)} more above</Text>
        </Box>
      )}
      {slice.map((row, i) => {
        const absoluteIndex = i + window.start;
        if (row.kind === 'header') {
          return <HeaderRowView key={`h-${row.groupKey}-${String(absoluteIndex)}`} row={row} />;
        }
        if (row.kind === 'create') {
          return <CreateRowView key={`create-${String(absoluteIndex)}`} focused={absoluteIndex === cursor} />;
        }
        return (
          <SprintRowView
            key={row.sprint.id}
            sprint={row.sprint}
            focused={absoluteIndex === cursor}
            isCurrent={currentSprintId === row.sprint.id}
          />
        );
      })}
      {window.hiddenBelow > 0 && (
        <Box paddingX={spacing.indent}>
          <Text dimColor>▼ {String(window.hiddenBelow)} more below</Text>
        </Box>
      )}
    </Box>
  );
};

const CreateRowView = ({ focused }: { readonly focused: boolean }): React.JSX.Element => (
  <Box flexDirection="column" paddingX={spacing.indent}>
    <Box>
      <Text color={focused ? inkColors.primary : inkColors.rule}>{focused ? '▍' : ' '}</Text>
      <Text>
        {' '}
        <Text color={focused ? inkColors.primary : inkColors.highlight} bold>
          + Create new sprint
        </Text>
      </Text>
    </Box>
    {focused && (
      <Box paddingLeft={3}>
        <Text dimColor>{glyphs.activityArrow} launches the create-sprint flow</Text>
      </Box>
    )}
  </Box>
);

const HeaderRowView = ({ row }: { readonly row: HeaderRow }): React.JSX.Element => {
  const color = row.orphan ? inkColors.warning : inkColors.muted;
  const prefix = row.orphan ? `${glyphs.warningGlyph} ` : '';
  return (
    <Box flexDirection="column" paddingX={spacing.indent} marginTop={spacing.section}>
      <Text bold color={color}>
        {prefix}
        {row.label}
      </Text>
      {row.empty && (
        <Box paddingLeft={3}>
          <Text dimColor>{glyphs.bullet} no sprints</Text>
        </Box>
      )}
    </Box>
  );
};

const SprintRowView = ({
  sprint,
  focused,
  isCurrent,
}: {
  readonly sprint: Sprint;
  readonly focused: boolean;
  readonly isCurrent: boolean;
}): React.JSX.Element => {
  return (
    <Box flexDirection="column" paddingX={spacing.indent}>
      <Box>
        <Text color={focused ? inkColors.primary : inkColors.rule}>{focused ? '▍' : ' '}</Text>
        <Text>
          {' '}
          <Text color={focused ? inkColors.primary : inkColors.muted} bold={focused}>
            {sprint.name}
          </Text>{' '}
          <StatusChip label={sprint.status} kind={sprintStatusKind(sprint.status)} />
          {isCurrent && (
            <Text dimColor italic>
              {' '}
              {glyphs.bullet} current
            </Text>
          )}
        </Text>
      </Box>
      {focused && (
        <Box paddingLeft={3}>
          <Text dimColor>
            {glyphs.activityArrow} {String(sprint.tickets.length)} ticket
            {sprint.tickets.length === 1 ? '' : 's'}
          </Text>
        </Box>
      )}
    </Box>
  );
};
