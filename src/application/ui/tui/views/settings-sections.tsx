/**
 * Read-side render of the Settings view's section strip + active-section body. Keeps the
 * orchestrator focused on hooks, key handling, and prompt mounting; this file owns the
 * "what does the active section look like" decision tree.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { FieldList } from '@src/application/ui/tui/components/field-list.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import type { PresetWarning } from '@src/application/flows/settings-apply-preset/ctx.ts';
import { PresetBar } from '@src/application/ui/tui/views/preset-bar.tsx';
import { AiRow, ImplementAiRow } from '@src/application/ui/tui/views/ai-row.tsx';
import { HarnessRow } from '@src/application/ui/tui/views/harness-row.tsx';
import type { SettingsSection } from '@src/application/ui/tui/views/settings-view-model.ts';

export interface SectionStripProps {
  readonly sections: readonly SettingsSection[];
  readonly activeIdx: number;
}

export const SectionStrip = ({ sections, activeIdx }: SectionStripProps): React.JSX.Element => (
  <Box flexWrap="wrap">
    {sections.map((sec, i) => {
      const isActive = i === activeIdx;
      return (
        <Box key={sec.id} marginRight={spacing.indent}>
          <Text {...(isActive ? { color: inkColors.primary } : { dimColor: true })} bold={isActive}>
            {isActive ? `${glyphs.actionCursor} ${sec.label}` : `  ${sec.label}`}
          </Text>
        </Box>
      );
    })}
  </Box>
);

export interface StoragePaths {
  readonly appRoot: string;
  readonly dataRoot: string;
  readonly configRoot: string;
}

export interface SectionBodyProps {
  readonly section: SettingsSection;
  readonly valueFor: (key: string) => React.ReactNode;
  readonly storage: StoragePaths;
  readonly presetWarnings: readonly PresetWarning[];
}

export const SectionBody = ({ section, valueFor, storage, presetWarnings }: SectionBodyProps): React.JSX.Element => {
  switch (section.id) {
    case 'storage':
      return (
        <Card title={section.title} tone="rule">
          <FieldList
            fields={[
              { label: 'App root', value: <Text dimColor>{storage.appRoot}</Text> },
              { label: 'Data root', value: <Text dimColor>{storage.dataRoot}</Text> },
              { label: 'Config root', value: <Text dimColor>{storage.configRoot}</Text> },
            ]}
          />
        </Card>
      );
    case 'presets':
      return <PresetBar title={section.title} valueFor={valueFor} warnings={presetWarnings} />;
    case 'implement':
      return <ImplementAiRow title={section.title} valueFor={valueFor} />;
    case 'harness':
      return <HarnessRow title={section.title} fields={section.fields} valueFor={valueFor} />;
    case 'global':
      return (
        <Card title={section.title} tone="primary">
          <FieldList fields={[{ label: 'Effort (default)', value: valueFor('ai.effort') }]} />
        </Card>
      );
    case 'other':
      return (
        <Card title={section.title} tone="primary">
          <FieldList
            fields={[
              { label: 'Log level', value: valueFor('logging.level') },
              { label: 'Concurrency', value: valueFor('concurrency.maxParallelTasks') },
            ]}
          />
        </Card>
      );
    case 'refine':
    case 'plan':
    case 'readiness':
    case 'ideate':
      return <AiRow title={section.title} sectionId={section.id} valueFor={valueFor} />;
  }
};
