/**
 * SprintSummary — completion progress bar shown at the top of the execute view.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Task } from '@src/domain/models.ts';
import { inkColors } from '@src/integration/ui/tui/theme/tokens.ts';

interface Props {
  tasks: readonly Task[];
  width?: number;
}

export function SprintSummary({ tasks, width = 30 }: Props): React.JSX.Element {
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === 'done').length;
  const active = tasks.filter((t) => t.status === 'in_progress').length;
  const todo = tasks.filter((t) => t.status === 'todo').length;

  const filled = total === 0 ? 0 : Math.round((done / total) * width);
  const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <Box>
      <Text color={inkColors.success}>{bar}</Text>
      <Text dimColor>
        {'  '}
        {String(done)}/{String(total)} ({String(pct)}%)
        {'  ·  '}
        {String(active)} active · {String(todo)} todo
      </Text>
    </Box>
  );
}
