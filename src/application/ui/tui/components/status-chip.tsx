/**
 * Inline status badge — `[DRAFT]`, `[ACTIVE]`, `[DONE]`. Color is the only signal the chip
 * carries; the bracketed label keeps it readable even in monochrome terminals.
 */

import React from 'react';
import { Text } from 'ink';
import { inkColors } from '@src/application/ui/tui/theme/tokens.ts';

export type StatusKind = 'success' | 'warning' | 'error' | 'info' | 'muted' | 'highlight';

export interface StatusChipProps {
  readonly label: string;
  readonly kind?: StatusKind;
}

const COLOR: Readonly<Record<StatusKind, string>> = {
  success: inkColors.success,
  warning: inkColors.warning,
  error: inkColors.error,
  info: inkColors.info,
  muted: inkColors.muted,
  highlight: inkColors.highlight,
};

export const StatusChip = ({ label, kind = 'info' }: StatusChipProps): React.JSX.Element => (
  <Text color={COLOR[kind]} bold>
    [{label.toUpperCase().replace(/_/g, ' ')}]
  </Text>
);

/** Map a sprint status to a chip kind. Centralised so every view agrees on the colour. */
export const sprintStatusKind = (status: string | undefined): StatusKind => {
  switch (status) {
    case 'draft':
      return 'muted';
    case 'planned':
      return 'info';
    case 'active':
      return 'success';
    case 'review':
      return 'warning';
    case 'done':
      return 'highlight';
    default:
      return 'muted';
  }
};

export const taskStatusKind = (status: string | undefined): StatusKind => {
  switch (status) {
    case 'todo':
      return 'muted';
    case 'in_progress':
      return 'info';
    case 'done':
      return 'success';
    case 'blocked':
      return 'error';
    default:
      return 'muted';
  }
};

export const ticketStatusKind = (status: string | undefined): StatusKind => {
  switch (status) {
    case 'pending':
      return 'warning';
    case 'approved':
      return 'success';
    default:
      return 'muted';
  }
};

export const runnerStatusKind = (status: string | undefined): StatusKind => {
  switch (status) {
    case 'idle':
      return 'muted';
    case 'running':
      return 'info';
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'aborted':
      return 'warning';
    default:
      return 'muted';
  }
};
