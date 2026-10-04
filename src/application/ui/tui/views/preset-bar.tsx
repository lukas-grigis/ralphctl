/**
 * Preset bar — twenty-six preset buttons across five families (Standard / Economic / Strong-gate /
 * Fast / Frontier). Each family renders under a dim bold sub-header so the rows stay scannable.
 * Activating a row opens a confirmation prompt in the parent view; this component is purely
 * the read-side render of the preset section card. Warnings from the most recent apply-preset
 * fan out as dimmed rows underneath so the operator sees missing-CLI guidance in-line.
 *
 * Keyboard navigation is unchanged — the sub-headers are visual-only; the cursor still walks
 * only the preset `EditableField` rows (the parent's `activeFields` array carries no headers).
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { FieldList } from '@src/application/ui/tui/components/field-list.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { PRESET_NAMES } from '@src/business/settings/presets.ts';
import { PROVIDER_BINARY } from '@src/integration/system/detect-cli.ts';
import type { PresetNotices } from '@src/application/flows/settings-apply-preset/ctx.ts';
import { presetAdaptationLines } from '@src/application/ui/shared/preset-notices.ts';
import {
  PRESET_FAMILY,
  PRESET_FAMILY_LABEL,
  PRESET_LABEL,
  type PresetFamily,
} from '@src/application/ui/tui/views/settings-view-model.ts';

export interface PresetBarProps {
  readonly title: string;
  readonly valueFor: (key: string) => React.ReactNode;
  readonly notices: PresetNotices;
}

/** Ordered families — drives the rendering order of sub-headers. */
const FAMILY_ORDER: readonly PresetFamily[] = ['standard', 'economic', 'strong-gate', 'fast', 'frontier'];

export const PresetBar = ({ title, valueFor, notices }: PresetBarProps): React.JSX.Element => {
  const adaptations = presetAdaptationLines(notices);
  return (
    <Card title={title} tone="primary">
      <Box flexDirection="column">
        {FAMILY_ORDER.map((family, familyIdx) => {
          const presets = PRESET_NAMES.filter((p) => PRESET_FAMILY[p] === family);
          return (
            <Box key={family} flexDirection="column" marginTop={familyIdx === 0 ? 0 : spacing.section}>
              <Box paddingX={spacing.indent}>
                <Text bold color={inkColors.muted}>
                  {PRESET_FAMILY_LABEL[family]}
                </Text>
              </Box>
              <FieldList
                fields={presets.map((preset) => ({
                  label: PRESET_LABEL[preset],
                  value: valueFor(`presets.${preset}`),
                }))}
              />
            </Box>
          );
        })}
      </Box>
      {notices.warnings.length + adaptations.length > 0 && (
        <Box flexDirection="column" paddingX={spacing.indent} marginTop={spacing.section}>
          {notices.warnings.map((w) => (
            <Text key={w.provider} dimColor>
              {glyphs.warningGlyph} {PROVIDER_BINARY[w.provider]} CLI not found on PATH; affects flows:{' '}
              {w.flows.join(', ')}
            </Text>
          ))}
          {adaptations.map((line) => (
            <Text key={line} dimColor>
              {glyphs.warningGlyph} {line}
            </Text>
          ))}
        </Box>
      )}
    </Card>
  );
};
