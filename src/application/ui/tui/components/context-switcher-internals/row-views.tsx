/**
 * Row presentation for the context switcher. `PickerRowList` owns cursor + windowing via the
 * shared `useListWindow` primitive (id-keyed on the cursorable subset — create, sprint and project
 * header rows); the row components below are pure presentation, driven entirely by props.
 *
 * One row pattern: a 1-cell cursor slot, the label, then right-hand context. `▸` is the only
 * cursor. Project headers sit at the list's left edge in bold caps; their sprints are indented one
 * step so the hierarchy reads without colour.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { sprintStatusKind, StatusChip } from '@src/application/ui/tui/components/status-chip.tsx';
import { computeListWindow, OverflowRow, useListWindow } from '@src/application/ui/tui/components/windowed-list.tsx';
import { plural } from '@src/application/ui/shared/plural.ts';
import { glyphs, inkColors, tones } from '@src/application/ui/tui/theme/tokens.ts';
import type { TaskHealthCounts } from '@src/application/ui/shared/state-snapshot.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type {
  CursorRow,
  FlatRow,
  HeaderRow,
} from '@src/application/ui/tui/components/context-switcher-internals/types.ts';
import {
  cursorableRowId,
  cursorableRows,
} from '@src/application/ui/tui/components/context-switcher-internals/group-builder.ts';

interface PickerRowListProps {
  readonly rows: readonly FlatRow[];
  readonly visibleRows: number;
  readonly active: boolean;
  readonly initialCursorId: string;
  readonly currentSprintId: SprintId | undefined;
  /** Project label the `+ New sprint in …` row names. */
  readonly createLabel: string | undefined;
  readonly onSubmit: (row: CursorRow) => void;
  /** Task-blocked health per sprint id — see `PickerData.taskHealthBySprintId`'s doc comment. */
  readonly taskHealthBySprintId: ReadonlyMap<SprintId, TaskHealthCounts>;
  /** Cells available for a row's content (box width minus border and padding). */
  readonly innerWidth: number;
}

/** Name column floor / ceiling so the chip column lines up without crowding a narrow box. */
const NAME_MIN = 12;
const NAME_MAX = 40;
/** Room the chip (`[IN PROGRESS]`), `current` and the blocked badge need after the name. */
const SPRINT_TAIL_WIDTH = 34;

/**
 * Windowed row list — id-keyed cursor via `useListWindow` over the cursorable subset drives focus
 * and keyboard handling. The RENDER slice is a separate window over the full flat row list
 * (non-cursorable orphan headers included), centred on the focused row's index in that full list,
 * so the rendered height stays bounded by `visibleRows` regardless of how many headers sit inside
 * or outside the window.
 *
 * Deliberately NOT `<WindowedList>`: that wrapper owns cursor movement AND the render window over
 * the *same* `items` array, but this view needs the cursor to move over the cursorable subset
 * while the render window slices the full row list — two different arrays. That is the "custom row
 * layout" case `WindowedList`'s own doc comment defers to `useListWindow` for.
 */
export const PickerRowList = ({
  rows,
  visibleRows,
  active,
  initialCursorId,
  currentSprintId,
  createLabel,
  onSubmit,
  taskHealthBySprintId,
  innerWidth,
}: PickerRowListProps): React.JSX.Element => {
  const items = useMemo(() => cursorableRows(rows), [rows]);

  const { focusedItem } = useListWindow<CursorRow>({
    items,
    getId: cursorableRowId,
    visibleRows,
    active,
    initialCursorId,
    onSubmit,
  });

  const focusedId = focusedItem !== undefined ? cursorableRowId(focusedItem) : undefined;

  // Index of the focused row within the FULL flat row list — the anchor for the render window.
  const focusedRowIndex = useMemo(() => {
    if (focusedId === undefined) return 0;
    const idx = rows.findIndex((row) => (row.kind !== 'header' || !row.orphan) && cursorableRowId(row) === focusedId);
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

  const nameWidth = useMemo(() => {
    const longest = rows.reduce((n, r) => (r.kind === 'sprint' ? Math.max(n, [...r.sprint.name].length) : n), 0);
    return Math.max(NAME_MIN, Math.min(NAME_MAX, longest, innerWidth - SPRINT_TAIL_WIDTH));
  }, [rows, innerWidth]);

  return (
    <Box flexDirection="column">
      <OverflowRow direction="above" count={renderWindow.hiddenAbove} />
      {renderRows.map((row) => {
        if (row.kind === 'create') {
          return <CreateRowView key="create" focused={focusedId === cursorableRowId(row)} label={createLabel} />;
        }
        if (row.kind === 'header') {
          return (
            <HeaderRowView
              key={`h-${row.groupKey}`}
              row={row}
              focused={!row.orphan && focusedId === cursorableRowId(row)}
            />
          );
        }
        return (
          <SprintRowView
            key={row.sprint.id}
            sprint={row.sprint}
            focused={focusedId === row.sprint.id}
            isCurrent={currentSprintId === row.sprint.id}
            health={taskHealthBySprintId.get(row.sprint.id)}
            nameWidth={nameWidth}
          />
        );
      })}
      <OverflowRow direction="below" count={renderWindow.hiddenBelow} />
    </Box>
  );
};

const Cursor = ({ focused }: { readonly focused: boolean }): React.JSX.Element => (
  <Text color={focused ? inkColors.primary : inkColors.rule}>{focused ? glyphs.actionCursor : ' '}</Text>
);

const CreateRowView = ({
  focused,
  label,
}: {
  readonly focused: boolean;
  readonly label: string | undefined;
}): React.JSX.Element => (
  <Box justifyContent="space-between">
    <Box>
      <Cursor focused={focused} />
      <Text color={focused ? inkColors.primary : inkColors.highlight} bold>
        {' '}
        + New sprint{label !== undefined ? ` in ${label}` : ''}
      </Text>
    </Box>
    <Text color={inkColors.highlight} bold>
      c
    </Text>
  </Box>
);

const HeaderRowView = ({ row, focused }: { readonly row: HeaderRow; readonly focused: boolean }): React.JSX.Element => {
  const color = row.orphan ? tones.warning.color : focused ? inkColors.primary : inkColors.muted;
  const repos = plural(row.repoCount, 'repo');
  const hint = row.orphan ? undefined : row.empty ? `no sprints ${glyphs.bullet} ↵ switch` : '↵ switch project';
  return (
    <Box justifyContent="space-between">
      <Box>
        <Cursor focused={focused} />
        <Text bold color={color}>
          {' '}
          {row.orphan ? `${tones.warning.glyph} ` : ''}
          {row.label.toUpperCase()}
        </Text>
        {!row.orphan && (
          <Text dimColor>
            {' '}
            {glyphs.bullet} {repos}
          </Text>
        )}
      </Box>
      {hint !== undefined && <Text dimColor>{hint}</Text>}
    </Box>
  );
};

const pad = (text: string, width: number): string => {
  const cps = [...text];
  if (cps.length > width) return `${cps.slice(0, Math.max(0, width - 1)).join('')}${glyphs.clipEllipsis}`;
  return text + ' '.repeat(width - cps.length);
};

const SprintRowView = ({
  sprint,
  focused,
  isCurrent,
  health,
  nameWidth,
}: {
  readonly sprint: Sprint;
  readonly focused: boolean;
  readonly isCurrent: boolean;
  /** Undefined only while the sprint's own fetch is still in flight — reads as zero counts. */
  readonly health: TaskHealthCounts | undefined;
  readonly nameWidth: number;
}): React.JSX.Element => {
  const blocked = health?.blockedTaskCount ?? 0;
  return (
    <Box>
      <Text> </Text>
      <Cursor focused={focused} />
      <Text {...(focused ? { color: inkColors.primary } : {})} bold={focused}>
        {' '}
        {pad(sprint.name, nameWidth)}
      </Text>
      <Text> </Text>
      <StatusChip label={sprint.status} kind={sprintStatusKind(sprint.status)} />
      {isCurrent && (
        <Text dimColor italic>
          {'  '}current
        </Text>
      )}
      {blocked > 0 && (
        <Text color={tones.warning.color} bold>
          {'  '}
          {tones.warning.glyph} {String(blocked)} blocked
        </Text>
      )}
    </Box>
  );
};
