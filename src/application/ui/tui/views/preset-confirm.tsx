/**
 * Preset-apply confirmation: shows which values the preset would rewrite (`SETTING  NOW → AFTER`)
 * before anything is written. A preset that changes nothing says so and writes nothing.
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { ConfirmCard } from '@src/application/ui/tui/components/confirm-card.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { diffPreset } from '@src/application/ui/tui/views/settings-preset-diff.ts';
import type { PresetName } from '@src/business/settings/presets.ts';
import type { Settings } from '@src/domain/entity/settings.ts';

/** Changed rows shown before collapsing into `… N more`. */
const MAX_ROWS = 8;

export interface PresetConfirmProps {
  readonly preset: PresetName;
  readonly settings: Settings;
  readonly onApply: () => void;
  /** Dismiss the confirmation (also called right before `onApply`). */
  readonly onClose: () => void;
}

const NothingToChange = ({ preset, onClose }: { readonly preset: PresetName; readonly onClose: () => void }) => {
  useInput((_input, key) => {
    if (key.escape || key.return) onClose();
  });
  return (
    <Box flexDirection="column" paddingX={spacing.indent}>
      <Card tone="info" title={`Already matches ${preset} ${glyphs.emDash} nothing to change`}>
        <Text dimColor>↵ / esc close</Text>
      </Card>
    </Box>
  );
};

export const PresetConfirm = ({ preset, settings, onApply, onClose }: PresetConfirmProps): React.JSX.Element => {
  const { changed, unchanged } = diffPreset(preset, settings);
  if (changed.length === 0) return <NothingToChange preset={preset} onClose={onClose} />;

  const total = changed.length + unchanged.length;
  const shown = changed.slice(0, MAX_ROWS);
  const width = Math.max(...shown.map((c) => c.setting.length));
  return (
    <ConfirmCard
      verb="Apply"
      target={`preset ${preset}`}
      body={
        <Box flexDirection="column">
          <Text>
            Applying {preset} changes {String(changed.length)} of {String(total)} values:
          </Text>
          {shown.map((c) => (
            <Text key={c.setting} wrap="truncate-end">
              {'  '}
              {c.setting.padEnd(width)} <Text dimColor>{c.now}</Text>{' '}
              <Text color={inkColors.primary}>{glyphs.arrowRight}</Text> {c.after}
            </Text>
          ))}
          {changed.length > shown.length && (
            <Text dimColor>
              {'  '}
              {glyphs.clipEllipsis} {String(changed.length - shown.length)} more
            </Text>
          )}
          {unchanged.length > 0 && (
            <Text dimColor wrap="truncate-end">
              Unchanged: {unchanged.join(', ')}
            </Text>
          )}
        </Box>
      }
      onSubmit={(yes) => {
        onClose();
        if (yes) onApply();
      }}
      onCancel={onClose}
    />
  );
};
