/**
 * Plain inline badge — no brackets, semantic color. Use for counts and short numeric labels
 * that don't carry the weight of a full status chip.
 */

import React from 'react';
import { Text } from 'ink';
import { inkColors } from '@src/application/ui/tui/theme/tokens.ts';

export type BadgeKind = 'info' | 'success' | 'warning' | 'error' | 'muted';

const COLOR: Readonly<Record<BadgeKind, string>> = {
  info: inkColors.info,
  success: inkColors.success,
  warning: inkColors.warning,
  error: inkColors.error,
  muted: inkColors.muted,
};

export interface BadgeProps {
  readonly children: React.ReactNode;
  readonly kind?: BadgeKind;
  readonly bold?: boolean;
}

export const Badge = ({ children, kind = 'muted', bold = false }: BadgeProps): React.JSX.Element => (
  <Text color={COLOR[kind]} bold={bold}>
    {children}
  </Text>
);
