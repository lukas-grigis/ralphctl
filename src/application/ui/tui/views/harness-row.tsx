/**
 * Harness section body — renders the iteration budget knobs (maxTurns / maxAttempts /
 * rateLimitRetries / plateauThreshold) with per-field one-line hints sourced from
 * `HARNESS_HINTS`. Edits route through the orchestrator's prompt-mounting machinery.
 */

import React from 'react';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { FieldList } from '@src/application/ui/tui/components/field-list.tsx';
import { HARNESS_HINTS, type EditableField } from '@src/application/ui/tui/views/settings-view-model.ts';

export interface HarnessRowProps {
  readonly title: string;
  readonly fields: readonly EditableField[];
  readonly valueFor: (key: string) => React.ReactNode;
}

export const HarnessRow = ({ title, fields, valueFor }: HarnessRowProps): React.JSX.Element => (
  <Card title={title} tone="primary">
    <FieldList
      fields={fields.map((f) => {
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
