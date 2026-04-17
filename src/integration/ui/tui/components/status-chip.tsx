/**
 * StatusChip — bracketed, semantic-colored status tag.
 *
 * Renders as `[DRAFT]`, `[ACTIVE]`, `[CLOSED]`, etc. Reads well in lists
 * and in stamp subtitles. Not a rounded pill — terminals can't.
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

/** Sensible kind for common statuses — keep semantic mapping in one place. */
export function chipKindForSprintStatus(status: 'draft' | 'active' | 'closed'): StatusKind {
  if (status === 'draft') return 'warning';
  if (status === 'active') return 'success';
  return 'muted';
}

export function chipKindForTaskStatus(status: 'todo' | 'in_progress' | 'done'): StatusKind {
  if (status === 'done') return 'success';
  if (status === 'in_progress') return 'warning';
  return 'muted';
}

export function StatusChip({ label, kind = 'info' }: StatusChipProps): React.JSX.Element {
  return (
    <Text color={COLOR[kind]} bold>
      [{label.toUpperCase()}]
    </Text>
  );
}
