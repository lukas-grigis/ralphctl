/**
 * Ancillary row renderers + presentation maps for the {@link TaskBlock} card. Carved out so
 * the main task-row file can focus on the per-task header + signals layout without spilling
 * over the 350-LOC per-file ceiling.
 *
 *   - {@link STATUS_PRESENTATION} / {@link SUB_STEP_PRESENTATION} — color + glyph lookups
 *   - {@link RecoveryLine}  — resume banner under the active-task header
 *   - {@link SubStepLine}   — one sub-step row inside a task card
 *   - {@link CriteriaBlock} — collapsed / expanded verification-criteria summary
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { TaskBucketStatus, TaskSubStep } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { RecoveryContext } from '@src/domain/entity/attempt.ts';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { fmtDuration, fmtIsoHHMM } from '@src/application/ui/tui/theme/duration.ts';
import {
  abortCauseLabel,
  collapseWhitespace,
  CRITERIA_COLLAPSED_LINES,
} from '@src/application/ui/tui/components/tasks-panel-internals/format.ts';

type TraceLikeStatus = 'completed' | 'failed' | 'aborted' | 'skipped';

export const STATUS_PRESENTATION: Readonly<
  Record<TaskBucketStatus, { readonly color: string; readonly glyph: string }>
> = {
  pending: { color: inkColors.muted, glyph: glyphs.phasePending },
  running: { color: inkColors.info, glyph: glyphs.phaseActive },
  completed: { color: inkColors.success, glyph: glyphs.phaseDone },
  failed: { color: inkColors.error, glyph: glyphs.cross },
  aborted: { color: inkColors.warning, glyph: glyphs.warningGlyph },
  skipped: { color: inkColors.muted, glyph: glyphs.phaseDisabled },
};

const SUB_STEP_PRESENTATION: Readonly<Record<TraceLikeStatus, { readonly color: string; readonly glyph: string }>> = {
  completed: { color: inkColors.success, glyph: glyphs.phaseDone },
  failed: { color: inkColors.error, glyph: glyphs.cross },
  aborted: { color: inkColors.warning, glyph: glyphs.warningGlyph },
  skipped: { color: inkColors.muted, glyph: glyphs.phaseDisabled },
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

/**
 * Two-item gen-eval activity indicator for the expanded active-task card. The currently-busy
 * role renders bright (`inkColors.info`); the idle role stays dim. When `role` is `undefined`
 * (the tail sub-step names neither role — e.g. a commit leaf, or a pre-attempt empty trace)
 * both render dim so the line reads as a neutral "no role active" state rather than implying
 * one side is working.
 */
export const BusyIndicator = ({
  role,
}: {
  readonly role: 'generator' | 'evaluator' | undefined;
}): React.JSX.Element => (
  <Box paddingLeft={spacing.indent}>
    {role === 'generator' ? (
      <Text color={inkColors.info}>generator {glyphs.busyDot}</Text>
    ) : (
      <Text dimColor>generator {glyphs.busyDot}</Text>
    )}
    <Text> </Text>
    {role === 'evaluator' ? (
      <Text color={inkColors.info}>evaluator {glyphs.busyDot}</Text>
    ) : (
      <Text dimColor>evaluator {glyphs.busyDot}</Text>
    )}
  </Box>
);

export const SubStepLine = ({
  sub,
  running,
}: {
  readonly sub: TaskSubStep;
  readonly running: boolean;
}): React.JSX.Element => {
  const presentation = SUB_STEP_PRESENTATION[sub.status];
  const glyph = running && sub.status === 'completed' ? presentation.glyph : presentation.glyph;
  return (
    <Box>
      <Text color={presentation.color} bold>
        {glyphs.activityArrow} {glyph}
      </Text>
      <Text> {sub.leafName}</Text>
      <Text dimColor>
        {' '}
        {glyphs.bullet} {fmtDuration(sub.durationMs)}
      </Text>
      {sub.errorMessage !== undefined && (
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text color={inkColors.error} wrap="truncate-end">
            {' '}
            {glyphs.emDash} {collapseWhitespace(sub.errorMessage)}
          </Text>
        </Box>
      )}
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
