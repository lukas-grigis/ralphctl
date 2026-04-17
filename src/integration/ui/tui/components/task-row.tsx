/**
 * TaskRow — single row in the live task grid.
 *
 * Visual: status icon · task name · dim project path · optional activity line.
 * Colour is driven by status + runtime flags (isRunning, isBlocked).
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Task, TaskStatus } from '@src/domain/models.ts';
import { glyphs, inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';

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
  if (isBlocked) return { icon: glyphs.cross, color: inkColors.error };
  if (status === 'done') return { icon: glyphs.check, color: inkColors.success };
  if (status === 'in_progress' || isRunning) return { icon: glyphs.actionCursor, color: inkColors.warning };
  return { icon: glyphs.bulletListItem, color: inkColors.muted, dim: true };
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
        <Text dimColor>{task.repoId}</Text>
      </Box>
      {activity ? (
        <Box paddingLeft={spacing.indent}>
          <Text color={inkColors.info} italic>
            {glyphs.activityArrow} {activity}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
