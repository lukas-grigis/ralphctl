/**
 * Step-aware header card for the add-ticket wizard.
 *  - `link` step (first): show the "What we'll collect" primer so a new user knows what's coming.
 *  - Mid-wizard steps (`fetching` → `title` → `description`): show a "Progress" card listing
 *    fields already entered. This is the fix for "old prompts vanish so I can't see what I
 *    typed" — the data persists in the header even after each prompt unmounts.
 *  - `confirm` / `saving` / `error`: handled by the step body itself (the confirm step renders
 *    its own "Review ticket" card containing all collected fields); header collapses so the
 *    Title doesn't appear twice on the same screen.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { FieldList } from '@src/application/ui/tui/components/field-list.tsx';
import { glyphs, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import type { Step } from '@src/application/ui/tui/views/add-ticket-internals/types.ts';

export const HeaderCard = ({ step }: { readonly step: Step }): React.JSX.Element | null => {
  if (step.kind === 'link') {
    return (
      <Card title="What we'll collect" tone="rule">
        <Box flexDirection="column" paddingX={spacing.indent}>
          <Text dimColor>
            {glyphs.bullet} an external issue link e.g. GitHub URL (optional — when provided, we fetch the issue and
            pre-fill title + description){'\n'}
            {glyphs.bullet} a short title (required){'\n'}
            {glyphs.bullet} a longer description (required)
          </Text>
        </Box>
      </Card>
    );
  }
  const collected = collectedFields(step);
  if (collected.length === 0) return null;
  return (
    <Card title="Progress" tone="rule">
      <Box flexDirection="column" paddingX={spacing.indent}>
        <FieldList fields={collected} />
      </Box>
    </Card>
  );
};

/**
 * Fields the user has committed *prior to* the active step. The active step's own prompt owns
 * its (in-progress) buffer; once submitted, it joins this list on the next render. The
 * `confirm` step is excluded — its body renders the full summary inside a Review card, so
 * surfacing the same Title in the Progress header would duplicate it on the same screen.
 */
const collectedFields = (step: Step): ReadonlyArray<{ readonly label: string; readonly value: React.ReactNode }> => {
  if (step.kind === 'confirm') return [];
  const fields: Array<{ readonly label: string; readonly value: React.ReactNode }> = [];
  const linkFor = (s: Step): string | undefined => {
    if (s.kind === 'fetching' || s.kind === 'fetch-failed' || s.kind === 'title' || s.kind === 'description') {
      return s.link;
    }
    return undefined;
  };
  const link = linkFor(step);
  if (link !== undefined && link.length > 0) {
    fields.push({ label: 'Link', value: <Text dimColor>{link}</Text> });
  }
  if (step.kind === 'description') {
    fields.push({ label: 'Title', value: <Text bold>{step.title}</Text> });
  }
  return fields;
};
