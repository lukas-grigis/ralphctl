/**
 * Row presentation for the sprint picker. `PickerRowList` owns cursor + windowing via the shared
 * `useListWindow` primitive (id-keyed on the cursorable subset — sprint + create rows); the row
 * components below are pure presentation, driven entirely by props.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { sprintStatusKind, StatusChip } from '@src/application/ui/tui/components/status-chip.tsx';
import { computeListWindow, OverflowRow, useListWindow } from '@src/application/ui/tui/components/windowed-list.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import {
  type CreateActionRow,
  type FlatRow,
  type HeaderRow,
  type SprintRow,
} from '@src/application/ui/tui/views/pick-sprint-internals/types.ts';
import { cursorableRowId, cursorableRows } from '@src/application/ui/tui/views/pick-sprint-internals/group-builder.ts';

interface PickerRowListProps {
  readonly rows: readonly FlatRow[];
  readonly visibleRows: number;
  readonly active: boolean;
  readonly initialCursorId: string;
  readonly currentSprintId: SprintId | undefined;
  readonly onSubmit: (row: SprintRow | CreateActionRow) => void;
}

/**
 * Windowed row list — id-keyed cursor via `useListWindow` over the cursorable subset (sprint +
 * create rows) drives focus and keyboard handling. The RENDER slice is a separate window over
 * the full flat row list (headers included), centred on the focused row's index in that full
 * list, so the rendered height stays bounded by `visibleRows` regardless of how many group
 * headers (empty or otherwise) sit inside or outside the window. A header only renders when it
 * falls inside the slice, exactly like any other row — no exemption for empty groups.
 *
 * Deliberately NOT `<WindowedList>`: that wrapper owns cursor movement AND the render window
 * over the *same* `items` array, but this view needs the cursor to move over the cursorable
 * subset while the render window slices the full row list (headers included) — two different
 * arrays. That's exactly the "custom row layout" case `WindowedList`'s own doc comment defers to
 * `useListWindow` for; this view stays on the raw hook plus a second, independent
 * `computeListWindow` call for the render slice.
 */
export const PickerRowList = ({
  rows,
  visibleRows,
  active,
  initialCursorId,
  currentSprintId,
  onSubmit,
}: PickerRowListProps): React.JSX.Element => {
  const items = useMemo(() => cursorableRows(rows), [rows]);

  const { focusedItem } = useListWindow<SprintRow | CreateActionRow>({
    items,
    getId: cursorableRowId,
    visibleRows,
    active,
    initialCursorId,
    onSubmit,
  });

  const focusedId = focusedItem !== undefined ? cursorableRowId(focusedItem) : undefined;

  // Index of the focused row within the FULL flat row list (headers included) — the anchor for
  // the render window. Falls back to 0 when nothing is focused yet (e.g. list still empty).
  const focusedRowIndex = useMemo(() => {
    if (focusedId === undefined) return 0;
    const idx = rows.findIndex((row) => row.kind !== 'header' && cursorableRowId(row) === focusedId);
    return idx < 0 ? 0 : idx;
  }, [rows, focusedId]);

  const renderWindow = useMemo(
    () => computeListWindow(rows.length, focusedRowIndex, visibleRows),
    [rows.length, focusedRowIndex, visibleRows]
  );

  const renderRows = useMemo(
    () => rows.slice(renderWindow.start, renderWindow.end),
    [rows, renderWindow.start, renderWindow.end]
  );

  return (
    <Box flexDirection="column">
      <OverflowRow direction="above" count={renderWindow.hiddenAbove} />
      {renderRows.map((row) => {
        if (row.kind === 'header') return <HeaderRowView key={`h-${row.groupKey}`} row={row} />;
        if (row.kind === 'create') return <CreateRowView key="create" focused={focusedId === cursorableRowId(row)} />;
        return (
          <SprintRowView
            key={row.sprint.id}
            sprint={row.sprint}
            focused={focusedId === row.sprint.id}
            isCurrent={currentSprintId === row.sprint.id}
          />
        );
      })}
      <OverflowRow direction="below" count={renderWindow.hiddenBelow} />
    </Box>
  );
};

const CreateRowView = ({ focused }: { readonly focused: boolean }): React.JSX.Element => (
  <Box flexDirection="column" paddingX={spacing.indent}>
    <Box>
      <Text color={focused ? inkColors.primary : inkColors.rule}>{focused ? glyphs.focusBar : ' '}</Text>
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
        <Text color={focused ? inkColors.primary : inkColors.rule}>{focused ? glyphs.focusBar : ' '}</Text>
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
