/**
 * TaskRow — single row in the live task grid.
 *
 * Visual: status icon · task name · dim project path · optional activity line.
 * Colour is driven by status + runtime flags (isRunning, isBlocked).
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Task, TaskStatus } from '@src/domain/models.ts';
import { inkColors } from '@src/integration/ui/tui/theme/tokens.ts';

interface Props {
  task: Task;
  isRunning?: boolean;
  isBlocked?: boolean;
  /** Most recent progress summary/activity from the task. */
  activity?: string;
}

interface StatusDisplay {
  icon: string;
  color: string;
  dim?: boolean;
}

function displayFor(status: TaskStatus, isRunning: boolean, isBlocked: boolean): StatusDisplay {
  if (isBlocked) return { icon: '✗', color: inkColors.error };
  if (status === 'done') return { icon: '✓', color: inkColors.success };
  if (status === 'in_progress' || isRunning) return { icon: '▸', color: inkColors.warning };
  return { icon: '·', color: inkColors.muted, dim: true };
}

export function TaskRow({ task, isRunning = false, isBlocked = false, activity }: Props): React.JSX.Element {
  const display = displayFor(task.status, isRunning, isBlocked);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={display.color}>{display.icon} </Text>
        <Text bold={display.dim !== true} dimColor={display.dim}>
          {task.name}
        </Text>
        <Text dimColor>{'   '}</Text>
        <Text dimColor>{task.projectPath}</Text>
      </Box>
      {activity ? (
        <Box paddingLeft={2}>
          <Text color={inkColors.info} italic>
            ↳ {activity}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
