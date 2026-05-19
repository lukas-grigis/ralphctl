/**
 * Tasks panel — per-task view of an Implement run. Each task block renders:
 *
 *   ✓ <id-short> · <duration> · <status>
 *     ↳ <sub-step name>          <duration>
 *     …
 *     eval passed  5.0/5.0
 *     correctness: 5/5 ✓  completeness: 5/5 ✓  …
 *     signals
 *       09:19  chng  added canvas-confetti …
 *       09:19  lern  useLocation + global side-effect …
 *       09:19  cmsg  feat(web-ui): add confetti …
 *
 * Cross-task signals (those whose timestamp doesn't fall inside any task window) pin at the top
 * as "Cross-task notes" so notes-about-the-run aren't lost.
 *
 * Correlation lives in `bucket-task-signals.ts`; this component is a pure renderer over the
 * bucketed structure.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type {
  BucketedExecution,
  TaskBucket,
  TaskSubStep,
  TaskBucketStatus,
} from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { EvaluationSignal, HarnessSignal } from '@src/domain/signal.ts';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { fmtDuration, fmtIsoTime } from '@src/application/ui/tui/theme/duration.ts';
import { useSpinnerFrame, spinnerGlyph } from '@src/application/ui/tui/runtime/use-spinner-frame.ts';

export interface TasksPanelProps {
  readonly bucketed: BucketedExecution;
  readonly running: boolean;
  /** Optional id → friendly name. Falls back to first 8 chars of the id. */
  readonly nameById?: ReadonlyMap<string, string>;
  /** Max signals per task to render; older ones drop off the top. */
  readonly maxSignalsPerTask?: number;
  /** Max orphan signals to render. */
  readonly maxOrphanSignals?: number;
}

const STATUS_PRESENTATION: Readonly<Record<TaskBucketStatus, { readonly color: string; readonly glyph: string }>> = {
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

type TraceLikeStatus = 'completed' | 'failed' | 'aborted' | 'skipped';

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Signal-label vocabulary. Labels are full words (not 4-letter codes) so the dashboard reads at
 * a glance without a legend. Keep names short — they sit in a label column alongside timestamps.
 *
 * Hover-tip-style descriptions: rendered next to the first signal of each kind via {@link SIGNAL_LEGEND}
 * if the operator runs `?` help, and inline in the legend strip below the Tasks header.
 */
const SIGNAL_LABEL_COLOR: Readonly<Record<string, string>> = {
  change: inkColors.info,
  learning: inkColors.highlight,
  decision: inkColors.highlight,
  commit: inkColors.info,
  note: inkColors.muted,
  progress: inkColors.info,
  'progress-entry': inkColors.info,
  done: inkColors.success,
  verified: inkColors.success,
  blocked: inkColors.error,
  script: inkColors.warning,
  proposal: inkColors.highlight,
  skills: inkColors.info,
};

interface SignalRow {
  readonly label: string;
  readonly text: string;
  readonly bold?: boolean;
}

const rowForSignal = (sig: HarnessSignal): SignalRow | undefined => {
  switch (sig.type) {
    case 'change':
      return { label: 'change', text: sig.text };
    case 'learning':
      return { label: 'learning', text: sig.text };
    case 'decision':
      return { label: 'decision', text: sig.text, bold: true };
    case 'commit-message':
      return { label: 'commit', text: sig.subject };
    case 'note':
      return { label: 'note', text: sig.text };
    case 'progress':
      return { label: 'progress', text: sig.summary };
    case 'progress-entry':
      return { label: 'progress-entry', text: sig.task };
    case 'task-complete':
      return { label: 'done', text: 'task complete' };
    case 'task-verified':
      return { label: 'verified', text: truncate(sig.output.replace(/\s+/g, ' '), 80) };
    case 'task-blocked':
      return { label: 'blocked', text: sig.reason };
    case 'check-script-discovery':
    case 'setup-script':
    case 'verify-script':
      return { label: 'script', text: `${sig.type}: ${sig.command}` };
    case 'agents-md-proposal':
      return { label: 'proposal', text: `context file proposal (${String(sig.content.length)} chars)` };
    case 'setup-skill-proposal':
      return { label: 'proposal', text: `setup-skill proposal (${String(sig.content.length)} chars)` };
    case 'verify-skill-proposal':
      return { label: 'proposal', text: `verify-skill proposal (${String(sig.content.length)} chars)` };
    case 'skill-suggestions':
      return { label: 'skills', text: sig.names.length > 0 ? sig.names.join(', ') : '(none)' };
    case 'evaluation':
      return undefined;
  }
};

/** Fixed label column so timestamps and bodies line up across signals. */
const SIGNAL_LABEL_WIDTH = 16;

const padLabel = (label: string): string => label.padEnd(SIGNAL_LABEL_WIDTH, ' ');

const SignalLine = ({ signal }: { readonly signal: HarnessSignal }): React.JSX.Element | null => {
  const row = rowForSignal(signal);
  if (row === undefined) return null;
  const color = SIGNAL_LABEL_COLOR[row.label] ?? inkColors.info;
  return (
    <Box>
      <Text dimColor>{fmtIsoTime(String(signal.timestamp))}</Text>
      <Text color={color} bold>
        {'  '}
        {padLabel(row.label)}
      </Text>
      <Text bold={row.bold ?? false}>{truncate(row.text, 80)}</Text>
    </Box>
  );
};

/**
 * Vertical legend rendered above the first task block. Keeps the dashboard readable when the
 * 4-letter shorthand was replaced by full words: the operator sees what `change`, `learning`,
 * `decision`, `verified`, `blocked` mean without leaving the view. One row per signal kind
 * with the label padded to {@link SIGNAL_LABEL_WIDTH} so the ` = description` column lines up
 * with the same column under each task's signals block.
 */
interface LegendEntry {
  readonly label: string;
  readonly color: string;
  readonly description: string;
}

const LEGEND_ENTRIES: readonly LegendEntry[] = [
  { label: 'change', color: inkColors.info, description: 'file/code edit' },
  { label: 'learning', color: inkColors.highlight, description: 'cross-task insight' },
  { label: 'decision', color: inkColors.highlight, description: 'design choice' },
  { label: 'verified', color: inkColors.success, description: 'task self-check passed' },
  { label: 'blocked', color: inkColors.error, description: 'task self-blocked' },
  { label: 'commit', color: inkColors.info, description: 'proposed commit message' },
];

const SignalLegend = (): React.JSX.Element => (
  <Box flexDirection="column" paddingX={spacing.indent} marginBottom={spacing.section}>
    <Text dimColor bold>
      legend
    </Text>
    <Box flexDirection="column" paddingLeft={2}>
      {LEGEND_ENTRIES.map((entry) => (
        <Box key={entry.label}>
          <Text color={entry.color} bold>
            {padLabel(entry.label)}
          </Text>
          <Text dimColor>= {entry.description}</Text>
        </Box>
      ))}
    </Box>
  </Box>
);

const EvaluationLine = ({ evaluation }: { readonly evaluation: EvaluationSignal }): React.JSX.Element => {
  const color =
    evaluation.status === 'passed'
      ? inkColors.success
      : evaluation.status === 'failed'
        ? inkColors.error
        : inkColors.warning;
  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>{fmtIsoTime(String(evaluation.timestamp))}</Text>
        <Text color={color} bold>
          {'  '}eval{'  '}
        </Text>
        <Text bold>{evaluation.status}</Text>
        {evaluation.overallScore !== undefined && (
          <Text dimColor>
            {' '}
            {glyphs.bullet} {evaluation.overallScore.toFixed(1)}/5.0
          </Text>
        )}
      </Box>
      {evaluation.dimensions.length > 0 && (
        <Box paddingLeft={6}>
          <Text dimColor>
            {evaluation.dimensions
              .map((d) => `${d.dimension}: ${String(d.score)}/5 ${d.passed ? glyphs.check : glyphs.cross}`)
              .join(`  ${glyphs.bullet}  `)}
          </Text>
        </Box>
      )}
    </Box>
  );
};

const SubStepLine = ({
  sub,
  running,
  spinner,
}: {
  readonly sub: TaskSubStep;
  readonly running: boolean;
  readonly spinner: string;
}): React.JSX.Element => {
  const presentation = SUB_STEP_PRESENTATION[sub.status];
  const glyph = running && sub.status === 'completed' ? presentation.glyph : presentation.glyph;
  void spinner;
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
        <Text color={inkColors.error}>
          {' '}
          {glyphs.emDash} {truncate(sub.errorMessage, 60)}
        </Text>
      )}
    </Box>
  );
};

const TaskBlock = ({
  task,
  running,
  display,
  maxSignals,
}: {
  readonly task: TaskBucket;
  readonly running: boolean;
  readonly display: string;
  readonly maxSignals: number;
}): React.JSX.Element => {
  const presentation = STATUS_PRESENTATION[task.status];
  const frame = useSpinnerFrame(running && task.status === 'running');
  const glyph = task.status === 'running' ? spinnerGlyph(frame) : presentation.glyph;
  const signalRows = task.signals.slice(-maxSignals);
  return (
    <Box flexDirection="column" marginBottom={spacing.section}>
      <Box>
        <Text color={presentation.color} bold>
          {glyph}
        </Text>
        <Text bold> {display}</Text>
        {task.durationMs !== undefined && (
          <Text dimColor>
            {' '}
            {glyphs.bullet} {fmtDuration(task.durationMs)}
          </Text>
        )}
        <Text dimColor>
          {' '}
          {glyphs.bullet} {task.status}
        </Text>
        {task.genEvalRound !== undefined && task.genEvalRound > 0 && (
          <Text color={inkColors.info}>
            {' '}
            {glyphs.bullet} round {String(task.genEvalRound)}
            {task.genEvalMaxRounds !== undefined ? `/${String(task.genEvalMaxRounds)}` : ''}
          </Text>
        )}
      </Box>
      {task.errorMessage !== undefined && (
        <Box paddingLeft={2}>
          <Text color={inkColors.error}>{task.errorMessage}</Text>
        </Box>
      )}
      {task.subSteps.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {task.subSteps.map((s, i) => (
            <SubStepLine key={`${task.id}-sub-${String(i)}`} sub={s} running={running} spinner={spinnerGlyph(frame)} />
          ))}
        </Box>
      )}
      {task.evaluations.length > 0 && (
        <Box flexDirection="column" paddingLeft={2} marginTop={1}>
          {task.evaluations.map((e, i) => (
            <EvaluationLine key={`${task.id}-eval-${String(i)}`} evaluation={e} />
          ))}
        </Box>
      )}
      {signalRows.length > 0 && (
        <Box flexDirection="column" paddingLeft={2} marginTop={1}>
          <Text dimColor>signals</Text>
          <Box flexDirection="column" paddingLeft={2}>
            {signalRows.map((s, i) => (
              <SignalLine key={`${task.id}-sig-${String(i)}`} signal={s} />
            ))}
          </Box>
        </Box>
      )}
    </Box>
  );
};

const OrphanSignals = ({
  signals,
  max,
}: {
  readonly signals: readonly HarnessSignal[];
  readonly max: number;
}): React.JSX.Element | null => {
  if (signals.length === 0) return null;
  const rows = signals.slice(-max);
  return (
    <Box flexDirection="column" marginBottom={spacing.section}>
      <Text dimColor bold>
        {glyphs.bullet} Cross-task notes
      </Text>
      <Box flexDirection="column" paddingLeft={2}>
        {rows.map((s, i) => (
          <SignalLine key={`orphan-${String(i)}`} signal={s} />
        ))}
      </Box>
    </Box>
  );
};

export const TasksPanel = ({
  bucketed,
  running,
  nameById,
  maxSignalsPerTask = 8,
  maxOrphanSignals = 6,
}: TasksPanelProps): React.JSX.Element => {
  if (bucketed.tasks.length === 0 && bucketed.orphanSignals.length === 0) {
    return (
      <Box paddingX={spacing.indent}>
        <Text dimColor>(no tasks yet)</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingX={spacing.indent}>
      <SignalLegend />
      <OrphanSignals signals={bucketed.orphanSignals} max={maxOrphanSignals} />
      {bucketed.tasks.map((task) => {
        const display = nameById?.get(task.id) ?? `${task.id.slice(0, 8)}…`;
        return (
          <TaskBlock key={task.id} task={task} running={running} display={display} maxSignals={maxSignalsPerTask} />
        );
      })}
    </Box>
  );
};
