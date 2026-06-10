/**
 * Harness section body — renders iteration budget knobs (maxTurns / maxAttempts /
 * rateLimitRetries / plateauThreshold), boolean toggles (escalateOnPlateau /
 * skipPreVerifyOnFreshSetup), and the read-only escalationMap display, with per-field
 * one-line hints sourced from `HARNESS_HINTS`. Edits route through the orchestrator's
 * prompt-mounting machinery; the escalationMap field is read-only with a CLI edit hint.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { FieldList } from '@src/application/ui/tui/components/field-list.tsx';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import { type EditableField, HARNESS_HINTS } from '@src/application/ui/tui/views/settings-view-model.ts';

const ESCALATION_MAP_CLI_HINT =
  'Read-only here — edit via: ralphctl settings set harness.escalationMap.<fromModel> <toModel>';

export interface HarnessRowProps {
  readonly title: string;
  readonly fields: readonly EditableField[];
  readonly valueFor: (key: string) => React.ReactNode;
}

export const HarnessRow = ({ title, fields, valueFor }: HarnessRowProps): React.JSX.Element => (
  <Card title={title} tone="primary">
    <FieldList
      fields={fields.map((f) => {
        if (f.kind === 'readonly-map') {
          const hint = ESCALATION_MAP_CLI_HINT;
          const value: React.ReactNode =
            f.entries.length === 0 ? (
              <Text dimColor>none {glyphs.emDash} defaults apply</Text>
            ) : (
              <Box flexDirection="column">
                {f.entries.map(({ from, to }) => (
                  <Text key={from} dimColor>
                    {from} {glyphs.arrowRight} {to}
                  </Text>
                ))}
              </Box>
            );
          return { label: f.label, value, hint };
        }
        const hint = HARNESS_HINTS[f.key];
        return {
          label: f.label,
          value: valueFor(f.key),
          ...(hint !== undefined ? { hint } : {}),
        };
      })}
    />
  </Card>
);
