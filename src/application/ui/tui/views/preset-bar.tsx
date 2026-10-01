/**
 * Preset list — twenty-six presets grouped under their five families (Standard / Economic / Strong-gate / Fast /
 * Frontier). Each row is the preset's name plus a dim account of what it sets; `↵ apply` lives in the footer.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { useScrollAnchor } from '@src/application/ui/tui/components/scroll-region.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { PROVIDER_BINARY } from '@src/integration/system/detect-cli.ts';
import type { PresetWarning } from '@src/application/flows/settings-apply-preset/ctx.ts';
import {
  PRESET_FAMILY,
  PRESET_FAMILY_LABEL,
  type EditableField,
  type PresetFamily,
} from '@src/application/ui/tui/views/settings-view-model.ts';

type PresetField = Extract<EditableField, { readonly kind: 'preset' }>;

export interface PresetBarProps {
  readonly title: string;
  readonly fields: readonly EditableField[];
  readonly focusedKey: string | undefined;
  readonly warnings: readonly PresetWarning[];
}

/** Ordered families — drives the rendering order of the group headings. */
const FAMILY_ORDER: readonly PresetFamily[] = ['standard', 'economic', 'strong-gate', 'fast', 'frontier'];

const isPreset = (f: EditableField): f is PresetField => f.kind === 'preset';

const PresetRow = ({
  field,
  focused,
  labelWidth,
}: {
  readonly field: PresetField;
  readonly focused: boolean;
  readonly labelWidth: number;
}): React.JSX.Element => {
  const anchorRef = useScrollAnchor(focused);
  return (
    <Box ref={anchorRef}>
      <Text wrap="truncate-end">
        <Text color={focused ? inkColors.primary : inkColors.muted} bold={focused}>
          {focused ? glyphs.actionCursor : ' '}{' '}
        </Text>
        <Text bold={focused} {...(focused ? { color: inkColors.primary } : {})}>
          {field.label.padEnd(labelWidth)}
        </Text>
        <Text dimColor>{`  ${field.current}`}</Text>
      </Text>
    </Box>
  );
};

export const PresetBar = ({ title, fields, focusedKey, warnings }: PresetBarProps): React.JSX.Element => {
  const presets = fields.filter(isPreset);
  const labelWidth = presets.reduce((w, f) => Math.max(w, f.label.length), 0);
  return (
    <Card title={title} tone="primary">
      <Box flexDirection="column">
        {FAMILY_ORDER.map((family, familyIdx) => (
          <Box key={family} flexDirection="column" marginTop={familyIdx === 0 ? 0 : spacing.section}>
            <Text bold color={inkColors.muted}>
              {PRESET_FAMILY_LABEL[family]}
            </Text>
            {presets
              .filter((f) => PRESET_FAMILY[f.preset] === family)
              .map((f) => (
                <PresetRow key={f.key} field={f} focused={f.key === focusedKey} labelWidth={labelWidth} />
              ))}
          </Box>
        ))}
      </Box>
      {warnings.length > 0 && (
        <Box flexDirection="column" marginTop={spacing.section}>
          {warnings.map((w) => (
            <Text key={w.provider} dimColor>
              {glyphs.warningGlyph} {PROVIDER_BINARY[w.provider]} CLI not found on PATH; affects flows:{' '}
              {w.flows.join(', ')}
            </Text>
          ))}
        </Box>
      )}
    </Card>
  );
};
