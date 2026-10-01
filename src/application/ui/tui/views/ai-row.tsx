/** AI section bodies. */

import React from 'react';
import { Box, Text } from 'ink';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { FieldList } from '@src/application/ui/tui/components/field-list.tsx';
import { spacing } from '@src/application/ui/tui/theme/tokens.ts';
import type { SectionId } from '@src/application/ui/tui/views/settings-view-model.ts';

export interface AiRowProps {
  readonly title: string;
  /** The per-flow section id — drives the dotted-path keys (`ai.<sectionId>.<field>`). */
  readonly sectionId: Exclude<SectionId, 'implement' | 'presets' | 'global' | 'harness' | 'other' | 'storage'>;
  readonly valueFor: (key: string) => React.ReactNode;
}

export const AiRow = ({ title, sectionId, valueFor }: AiRowProps): React.JSX.Element => (
  <Card title={title} tone="primary">
    <FieldList
      fields={[
        { label: 'Provider', value: valueFor(`ai.${sectionId}.provider`) },
        { label: 'Model', value: valueFor(`ai.${sectionId}.model`) },
        { label: 'Effort', value: valueFor(`ai.${sectionId}.effort`) },
      ]}
    />
  </Card>
);

export interface ImplementAiRowProps {
  readonly title: string;
  readonly valueFor: (key: string) => React.ReactNode;
}

export const ImplementAiRow = ({ title, valueFor }: ImplementAiRowProps): React.JSX.Element => (
  <Card title={title} tone="primary">
    {(['generator', 'evaluator'] as const).map((role, idx) => (
      <Box key={role} flexDirection="column" paddingLeft={spacing.indent} marginTop={idx === 0 ? 0 : spacing.section}>
        <Text dimColor bold>
          {role}
        </Text>
        <FieldList
          fields={[
            { label: 'Provider', value: valueFor(`ai.implement.${role}.provider`) },
            { label: 'Model', value: valueFor(`ai.implement.${role}.model`) },
            { label: 'Effort', value: valueFor(`ai.implement.${role}.effort`) },
          ]}
        />
      </Box>
    ))}
  </Card>
);
