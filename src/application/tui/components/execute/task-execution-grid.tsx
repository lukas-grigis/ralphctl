/**
 * TaskExecutionGrid — thin wrapper that renders the dependency-aware task
 * list under a section header.
 *
 * Was previously an orchestrator picking between a layered DAG and the list;
 * the DAG was hard to keep correct under wrapping, long-range edges, and
 * varying terminal widths. The list is the canonical "simple yet effective"
 * representation: depth-indented, status pill, activity line, depends-on
 * line, blocked reason. This wrapper exists only to keep the existing
 * `<TaskExecutionGrid />` import path stable in `execute-view.tsx`.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';
import { TaskExecutionList } from './task-execution-list.tsx';
import type { TaskGridItem } from './task-grid-item.ts';
import type { HarnessSignal } from '@src/domain/signals/harness-signal.ts';

export interface TaskExecutionGridProps {
  readonly tasks: readonly TaskGridItem[] | null;
  readonly taskNameLookup: Map<string, string> | null;
  readonly taskSignals: ReadonlyMap<string, HarnessSignal> | null;
}

export function TaskExecutionGrid({
  tasks,
  taskNameLookup,
  taskSignals,
}: TaskExecutionGridProps): React.JSX.Element | null {
  if (tasks === null || tasks.length === 0) return null;

  return (
    <Box flexDirection="column" marginTop={spacing.section}>
      <Text dimColor bold color={inkColors.muted}>
        {glyphs.activityArrow} Task execution
      </Text>
      <TaskExecutionList tasks={tasks} taskNameLookup={taskNameLookup} taskSignals={taskSignals} />
    </Box>
  );
}
