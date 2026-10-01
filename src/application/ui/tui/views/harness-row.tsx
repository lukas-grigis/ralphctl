/**
 * Harness section body — renders iteration budget knobs (maxTurns / maxAttempts / rateLimitRetries / idleWatchdogMs /
 * plateauThreshold).
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { FieldList } from '@src/application/ui/tui/components/field-list.tsx';
import { glyphs, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import {
  type EditableField,
  effectiveEscalationChains,
  ESCALATION_ENTRY_HINT,
  HARNESS_HINTS,
} from '@src/application/ui/tui/views/settings-view-model.ts';

export interface HarnessRowProps {
  readonly title: string;
  readonly fields: readonly EditableField[];
  readonly valueFor: (key: string) => React.ReactNode;
}

export const HarnessRow = ({ title, fields, valueFor }: HarnessRowProps): React.JSX.Element => {
  // The map-entry fields ARE the persisted overrides — derive instead of threading a prop.
  const overrides = Object.fromEntries(
    fields.flatMap((f) => (f.kind === 'map-entry' ? [[f.from, f.to] as const] : []))
  );
  const chains = effectiveEscalationChains(overrides);
  return (
    <Card title={title} tone="primary">
      <FieldList
        fields={fields.map((f) => {
          const hint = f.kind === 'map-entry' ? ESCALATION_ENTRY_HINT : HARNESS_HINTS[f.key];
          return {
            label: f.label,
            value: valueFor(f.key),
            ...(hint !== undefined ? { hint } : {}),
          };
        })}
      />
      <Box flexDirection="column" marginTop={spacing.section}>
        <Text dimColor>Effective ladder (built-in {glyphs.bullet} overrides win):</Text>
        {chains.map((chain) => (
          <Text key={`${chain.provider ?? 'custom'}:${chain.models[0] ?? ''}`} dimColor>
            {'  '}
            {chain.provider ?? 'any provider'}: {chain.models.join(` ${glyphs.arrowRight} `)}
            {chain.customised ? ' (customised)' : ''}
          </Text>
        ))}
      </Box>
    </Card>
  );
};
