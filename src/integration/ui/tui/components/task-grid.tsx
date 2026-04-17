/**
 * TaskGrid — rendered list of all tasks in the current sprint, with
 * per-task runtime state (running, blocked, last-activity) layered on top.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Task } from '@src/domain/models.ts';
import { TaskRow } from './task-row.tsx';

interface Props {
  tasks: readonly Task[];
  runningTaskIds: ReadonlySet<string>;
  blockedTaskIds: ReadonlySet<string>;
  /** taskId → latest activity line (from progress signals). */
  activityByTask: ReadonlyMap<string, string>;
}

export function TaskGrid({ tasks, runningTaskIds, blockedTaskIds, activityByTask }: Props): React.JSX.Element {
  if (tasks.length === 0) {
    return (
      <Box>
        <Text dimColor>No tasks.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {tasks.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          isRunning={runningTaskIds.has(task.id)}
          isBlocked={blockedTaskIds.has(task.id)}
          activity={activityByTask.get(task.id)}
        />
      ))}
    </Box>
  );
}
