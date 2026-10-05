/**
 * Ancillary row renderers + presentation maps for the {@link TaskBlock} card. Carved out so
 * the main task-row file can focus on the per-task header + signals layout without spilling
 * over the 350-LOC per-file ceiling.
 *
 *   - {@link STATUS_PRESENTATION} — color + glyph lookup
 *   - {@link RecoveryLine}  — resume banner under the active-task header
 *   - {@link CriteriaBlock} — collapsed / expanded verification-criteria summary
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { TaskBucketStatus } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import { isFreeAbortCause, type RecoveryContext } from '@src/domain/entity/attempt.ts';
import { glyphFor, glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { fmtIsoHHMM } from '@src/application/ui/tui/theme/duration.ts';
import {
  abortCauseLabel,
  collapseWhitespace,
  CRITERIA_COLLAPSED_LINES,
} from '@src/application/ui/tui/components/tasks-panel-internals/format.ts';

export const STATUS_PRESENTATION: Readonly<
  Record<TaskBucketStatus, { readonly color: string; readonly glyph: string }>
> = {
  pending: { color: inkColors.muted, glyph: glyphs.phasePending },
  running: { color: inkColors.info, glyph: glyphs.phaseActive },
  completed: { color: inkColors.success, glyph: glyphs.phaseDone },
  failed: { color: inkColors.error, glyph: glyphs.cross },
  aborted: { color: inkColors.warning, glyph: glyphs.warningGlyph },
  skipped: { color: inkColors.muted, glyph: glyphs.phaseDisabled },
  // Error-level, NOT muted: a dependency-blocked task needs the operator's attention — it must
  // never read as the same grey as a merely-`pending` task. `glyphFor('blocked')` is the same
  // triangle already reserved for the `blocked` harness-signal kind, distinct from `cross`
  // (failed) / `warningGlyph` (aborted) / `phaseDisabled` (skipped).
  blocked: { color: inkColors.error, glyph: glyphFor('blocked') },
};

export const RecoveryLine = ({
  attemptN,
  context,
}: {
  readonly attemptN: number;
  readonly context: RecoveryContext;
}): React.JSX.Element => {
  // HH:MM from the ISO timestamp in local time — keep `fmtIsoTime` for the seconds-precise
  // variant; the resume banner shows wall-clock at minute granularity to match what a user
  // sees on a sprint header (we don't need second precision).
  const hhmm = fmtIsoHHMM(String(context.abortedAt));
  const label = abortCauseLabel(context.cause);
  // A free resume continues the same budgeted attempt; raw attempt numbers would contradict the `attempt A/X` chip.
  if (isFreeAbortCause(context.cause)) {
    return (
      <Box paddingLeft={spacing.indent}>
        <Text wrap="truncate-end">
          <Text dimColor>{glyphs.activityArrow} </Text>
          <Text color={inkColors.warning}>resumed</Text>
          <Text> after the stop at {hhmm}</Text>
          {label !== undefined && <Text dimColor> ({label})</Text>}
          <Text dimColor> {glyphs.bullet} no attempt used</Text>
        </Text>
      </Box>
    );
  }
  return (
    <Box paddingLeft={spacing.indent}>
      <Text dimColor>{glyphs.activityArrow} </Text>
      <Text>attempt {String(attemptN)}</Text>
      <Text dimColor> {glyphs.bullet} </Text>
      <Text color={inkColors.warning}>resumed from aborted</Text>
      <Text>
        {' '}
        {String(context.fromAttemptN)} at {hhmm}
      </Text>
      {label !== undefined && <Text dimColor> ({label})</Text>}
    </Box>
  );
};

export const CriteriaBlock = ({
  bullets,
  expanded,
}: {
  readonly bullets: readonly string[];
  readonly expanded: boolean;
}): React.JSX.Element | null => {
  if (bullets.length === 0) return null;
  const visible = expanded ? bullets : bullets.slice(0, CRITERIA_COLLAPSED_LINES);
  const overflow = bullets.length - visible.length;
  return (
    <Box flexDirection="column" paddingLeft={spacing.indent}>
      <Box>
        <Text dimColor>{glyphs.bullet} criteria</Text>
        {!expanded && bullets.length > CRITERIA_COLLAPSED_LINES && (
          <Text dimColor> {glyphs.bullet} press e to expand</Text>
        )}
        {expanded && bullets.length > CRITERIA_COLLAPSED_LINES && (
          <Text dimColor> {glyphs.bullet} press e to collapse</Text>
        )}
      </Box>
      <Box flexDirection="column" paddingLeft={spacing.indent}>
        {visible.map((b, i) => (
          <Box key={`crit-row-${String(i)}`}>
            <Text dimColor>{glyphs.bullet} </Text>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text wrap="truncate-end">{collapseWhitespace(b)}</Text>
            </Box>
          </Box>
        ))}
        {overflow > 0 && (
          // Multi-line collapse marker (audit-[03]): explicit `▼ more` glyph denotes that
          // a user-expand affordance exists — the `press e to expand` hint on the heading
          // names the hotkey.
          <Text dimColor>
            {glyphs.collapseExpand} ({String(overflow)})
          </Text>
        )}
      </Box>
    </Box>
  );
};
