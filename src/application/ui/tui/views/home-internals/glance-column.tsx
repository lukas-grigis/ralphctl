/** Work's right-hand glance column from `lg`: the sprint's tasks and the recent sprints. */

import React from 'react';
import { Box, Text } from 'ink';
import { StatusChip, sprintStatusKind } from '@src/application/ui/tui/components/status-chip.tsx';
import { TaskMinimap } from '@src/application/ui/tui/components/task-minimap.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';

export const RECENT_SPRINT_ROWS = 5;

const GlanceHeader = ({
  title,
  count,
  right,
}: {
  readonly title: string;
  readonly count?: number;
  readonly right?: string;
}): React.JSX.Element => (
  <Box paddingX={spacing.indent} justifyContent="space-between">
    <Text color={inkColors.muted} bold>
      {title}
      {count !== undefined ? `  ${String(count)}` : ''}
    </Text>
    {right !== undefined && <Text dimColor>{right}</Text>}
  </Box>
);

export const GlanceColumn = ({
  snapshot,
  width,
  taskRows,
  interruptedIds,
  stoppedIds,
}: {
  readonly snapshot: AppStateSnapshot;
  readonly width: number;
  readonly taskRows: number;
  readonly interruptedIds?: ReadonlySet<string>;
  readonly stoppedIds?: ReadonlySet<string>;
}): React.JSX.Element => (
  <Box flexDirection="column" width={width} flexShrink={0}>
    <GlanceHeader title="TASKS" count={snapshot.tasks.length} />
    <TaskMinimap
      tasks={snapshot.tasks}
      visibleRows={taskRows}
      width={width}
      {...(interruptedIds !== undefined ? { interruptedIds } : {})}
      {...(stoppedIds !== undefined ? { stoppedIds } : {})}
    />
    <Box marginTop={spacing.section} flexDirection="column">
      <GlanceHeader title="RECENT SPRINTS" right="S switch" />
      {snapshot.recentSprints.slice(0, RECENT_SPRINT_ROWS).map((s) => (
        <Box key={s.id} paddingX={spacing.indent} justifyContent="space-between">
          <Text wrap="truncate-end" bold={s.id === snapshot.sprint?.id}>
            {s.id === snapshot.sprint?.id ? glyphs.focusBar : ' '}
            {s.name}
          </Text>
          <Box flexShrink={0} marginLeft={1}>
            <StatusChip label={s.status.toUpperCase()} kind={sprintStatusKind(s.status)} />
          </Box>
        </Box>
      ))}
    </Box>
  </Box>
);
