/**
 * AI section bodies. `AiRow` renders the flat three-row card used by refine / plan / readiness
 * / ideate; `ImplementAiRow` renders the Implement-only nested parent card with generator +
 * evaluator sub-rows underneath. Both surfaces are read-only render — edits route through the
 * orchestrator's prompt-mounting machinery.
 *
 * Implement is the only flow whose runtime carries two AI sessions per task (the generator
 * that proposes a commit and the evaluator that judges it). Rendering it as a parent card with
 * indented sub-rows surfaces at-a-glance that they are two halves of the same flow rather than
 * two independent flows. Edits on either role flow through the same dotted-path keys
 * (`ai.implement.<role>.<field>`) so changing one role's provider/model/effort cannot perturb
 * the other.
 */

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
