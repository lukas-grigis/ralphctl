/**
 * StatusChip — bracketed, semantic-colored status tag.
 *
 * Renders as `[DRAFT]`, `[ACTIVE]`, `[CLOSED]`, etc. Reads well in lists
 * and in stamp subtitles.
 */

import React from 'react';
import { Text } from 'ink';
import { inkColors } from '@src/integration/ui/theme/tokens.ts';

export type StatusKind = 'info' | 'success' | 'warning' | 'error' | 'muted';

interface StatusChipProps {
  readonly label: string;
  readonly kind?: StatusKind;
}

const COLOR: Record<StatusKind, string> = {
  info: inkColors.info,
  success: inkColors.success,
  warning: inkColors.warning,
  error: inkColors.error,
  muted: inkColors.muted,
};

export function chipKindForSprintStatus(status: 'draft' | 'active' | 'closed'): StatusKind {
  if (status === 'draft') return 'warning';
  if (status === 'active') return 'success';
  return 'muted';
}

export function chipKindForTaskStatus(
  status: 'todo' | 'in_progress' | 'done' | 'blocked' | 'cancelled' | 'skipped'
): StatusKind {
  if (status === 'done') return 'success';
  if (status === 'in_progress') return 'warning';
  if (status === 'skipped') return 'warning';
  if (status === 'blocked') return 'error';
  return 'muted';
}

export function chipKindForSessionStatus(status: 'idle' | 'running' | 'completed' | 'failed' | 'aborted'): StatusKind {
  if (status === 'running') return 'warning';
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'aborted') return 'muted';
  return 'muted';
}

export function StatusChip({ label, kind = 'info' }: StatusChipProps): React.JSX.Element {
  return (
    <Text color={COLOR[kind]} bold>
      [{label.toUpperCase()}]
    </Text>
  );
}
