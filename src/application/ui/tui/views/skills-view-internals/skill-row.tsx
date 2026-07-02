/**
 * One catalog row: name (+ "(manual)" tag for a non-bundled entry), one-line description,
 * per-flow status chips, and a dim "recommended:" line when the registry suggests extra phases.
 * Presentational only — `skills-view.tsx` owns the cursor + action wiring.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { FLOW_IDS } from '@src/domain/value/flow-id.ts';
import type { SkillCatalogEntry } from '@src/integration/ai/skills/_engine/skill-catalog-port.ts';
import { StatusChip } from '@src/application/ui/tui/components/status-chip.tsx';
import { inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { FLOW_ABBR, flowChipVisual } from '@src/application/ui/tui/views/skills-view-internals/flow-visual.ts';

export interface SkillRowProps {
  readonly entry: SkillCatalogEntry;
  readonly focused: boolean;
  /** `false` for a hand-dropped phase-folder entry with no matching `BUNDLED_SKILLS` row. */
  readonly isBundled: boolean;
}

export const SkillRow = ({ entry, focused, isBundled }: SkillRowProps): React.JSX.Element => {
  const updateCount = entry.installs.filter((i) => i.status === 'update-available').length;
  return (
    <Box flexDirection="column" marginBottom={spacing.section}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={focused ? inkColors.primary : inkColors.rule}
        borderDimColor={!focused}
        paddingX={spacing.cardPadX}
      >
        <Box justifyContent="space-between">
          <Text bold {...(focused ? { color: inkColors.primary } : {})}>
            {entry.name}
            {!isBundled && <Text dimColor> (manual)</Text>}
          </Text>
          {updateCount > 0 && (
            <StatusChip label={`${String(updateCount)} update${updateCount === 1 ? '' : 's'}`} kind="warning" />
          )}
        </Box>
        <Text dimColor wrap="truncate-end">
          {entry.description.length > 0 ? entry.description : '(no description)'}
        </Text>
        <Box>
          {FLOW_IDS.map((flowId) => {
            const visual = flowChipVisual(flowId, entry);
            return (
              <Text key={flowId} color={visual.color} bold={visual.bold}>
                {visual.glyph} {FLOW_ABBR[flowId]}
                {'  '}
              </Text>
            );
          })}
        </Box>
        {entry.recommendedFor.length > 0 && (
          <Text dimColor>recommended: {entry.recommendedFor.map((f) => FLOW_ABBR[f]).join(', ')}</Text>
        )}
      </Box>
    </Box>
  );
};
