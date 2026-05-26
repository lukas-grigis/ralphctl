/**
 * Preset bar — four equal preset buttons (mixed / claude-only / copilot-only / codex-only).
 * Activating a row opens a confirmation prompt in the parent view; this component is purely
 * the read-side render of the preset section card. Warnings from the most recent apply-preset
 * fan out as dimmed rows underneath so the operator sees missing-CLI guidance in-line.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { FieldList } from '@src/application/ui/tui/components/field-list.tsx';
import { glyphs, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { PRESET_NAMES } from '@src/business/settings/presets.ts';
import type { PresetWarning } from '@src/application/flows/settings-apply-preset/ctx.ts';
import { PRESET_LABEL } from '@src/application/ui/tui/views/settings-view-model.ts';

export interface PresetBarProps {
  readonly title: string;
  readonly valueFor: (key: string) => React.ReactNode;
  readonly warnings: readonly PresetWarning[];
}

export const PresetBar = ({ title, valueFor, warnings }: PresetBarProps): React.JSX.Element => (
  <Card title={title} tone="primary">
    <FieldList
      fields={PRESET_NAMES.map((preset) => ({
        label: PRESET_LABEL[preset],
        value: valueFor(`presets.${preset}`),
      }))}
    />
    {warnings.length > 0 && (
      <Box flexDirection="column" paddingX={spacing.indent} marginTop={spacing.section}>
        {warnings.map((w) => (
          <Text key={w.provider} dimColor>
            {glyphs.warningGlyph} {w.provider} CLI not found on PATH; affects flows: {w.flows.join(', ')}
          </Text>
        ))}
      </Box>
    )}
  </Card>
);
