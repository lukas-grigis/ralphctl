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
import type { AbortCause, RecoveryContext } from '@src/domain/entity/attempt.ts';
import type { ContextCompactedSignal, EvaluationSignal, HarnessSignal } from '@src/domain/signal.ts';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { fmtDuration, fmtIsoTime } from '@src/application/ui/tui/theme/duration.ts';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';

export interface TasksPanelProps {
  readonly bucketed: BucketedExecution;
  readonly running: boolean;
  /** Optional id → friendly name. Falls back to first 8 chars of the id. */
  readonly nameById?: ReadonlyMap<string, string>;
  /** Max signals per task to render; older ones drop off the top. */
  readonly maxSignalsPerTask?: number;
  /** Max orphan signals to render. */
  readonly maxOrphanSignals?: number;
  /**
   * Max sub-step rows per task to render; older ones drop off the top behind a single elision
   * row. Bounds Ink reconciliation cost on long gen-eval loops (every retry adds ~12 leaves),
   * preventing the OOM mode where unbounded child lists thrash the V8 heap every spinner tick.
   */
  readonly maxSubStepsPerTask?: number;
  /** Max evaluation rows per task to render; same elision treatment as sub-steps. */
  readonly maxEvaluationsPerTask?: number;
  /**
   * Optional `taskId → RecoveryContext` map for tasks the launcher detected as resuming a
   * prior aborted attempt. When set for a given task id the active-task header gets a second
   * row: `↳ attempt N · resumed from aborted M at HH:MM (CAUSE)`. Absent / empty when no
   * task in the run is a resume.
   */
  readonly recoveringByTaskId?: ReadonlyMap<string, RecoveryContext>;
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

/**
 * Collapse runs of whitespace to a single space so multi-line content (e.g. a `task-verified`
 * signal's `output`) renders as one row before Ink ellides on width. We deliberately do not
 * char-clip here — Ink's `wrap="truncate-end"` handles width-based ellision based on actual
 * terminal columns. See {@link SignalLine} for the flexbox shape that constrains the body box.
 */
const collapseWhitespace = (s: string): string => s.replace(/\s+/g, ' ');

/**
 * Signal-label vocabulary. Labels are full words (not 4-letter codes) so the dashboard reads at
 * a glance without a legend. Keep names short — they sit in a label column alongside timestamps.
 *
 * Single source of truth for signal-label colours: consumed by the inline-kinds bar in this
 * file AND by the help overlay's `Signals` reference section. Adding a new signal kind means
 * one edit here plus an entry in `keySections.signalReference`.
 *
 * @public
 */
export const SIGNAL_LABEL_COLOR: Readonly<Record<string, string>> = {
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
    case 'commit-message': {
      // Prefer the harness-resolved `fullMessage` (subject + body + `Closes …` trailer) — the
      // AI's pre-trailer `subject` can diverge from what actually lands in git history if the
      // harness clamped or rewrote it. Display the first line; the multi-line expansion UX
      // lands in a follow-up.
      const headline = sig.fullMessage !== undefined ? (sig.fullMessage.split('\n', 1)[0] ?? sig.subject) : sig.subject;
      return { label: 'commit', text: headline };
    }
    case 'note':
      return { label: 'note', text: sig.text };
    case 'progress':
      return { label: 'progress', text: sig.summary };
    case 'progress-entry':
      return { label: 'progress-entry', text: sig.task };
    case 'task-complete':
      return { label: 'done', text: 'task complete' };
    case 'task-verified':
      return { label: 'verified', text: collapseWhitespace(sig.output) };
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
    case 'context-compacted':
      // Both render outside the per-signal label column — `evaluation` via its dedicated
      // `<EvaluationLine>` row, `context-compacted` via `<CompactionMarker>` (a dedented
      // lifecycle-boundary marker rendered inline with the signal stream).
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
  // Layout: fixed timestamp + fixed label column + flex-grow body that ellides on the
  // terminal's actual width via Ink's `wrap="truncate-end"`. The body is a row that may
  // shrink (so long messages don't push the layout); the label box is fixed-width and never
  // shrinks. Collapsing whitespace on the body line keeps multi-line payloads (e.g. commit
  // bodies) readable as a single ellided row until the expansion UX lands.
  return (
    <Box>
      <Text dimColor>{fmtIsoTime(String(signal.timestamp))}</Text>
      <Text color={color} bold>
        {'  '}
        {padLabel(row.label)}
      </Text>
      <Box flexGrow={1} flexShrink={1}>
        <Text bold={row.bold ?? false} wrap="truncate-end">
          {collapseWhitespace(row.text)}
        </Text>
      </Box>
    </Box>
  );
};

/**
 * Compact a token count for display: `200000` → `200k`, `1500` → `1.5k`, `120` → `120`. The
 * provider's reported numbers can be large (context windows trend 100k-200k); collapsing to a
 * one-or-two-char "k" suffix keeps the marker scannable inside one terminal row.
 */
const fmtTokens = (n: number): string => {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return k >= 100 ? `${String(Math.round(k))}k` : `${k.toFixed(1).replace(/\.0$/, '')}k`;
};

/**
 * Render the parenthetical detail block of a `context-compacted` marker. Returns `undefined`
 * when neither token counts nor preserved topics were reported by the provider — the marker
 * then degrades gracefully to the bare "context compacted" boundary.
 */
const formatCompactionDetail = (sig: ContextCompactedSignal): string | undefined => {
  const parts: string[] = [];
  if (sig.beforeTokens !== undefined && sig.afterTokens !== undefined) {
    parts.push(`${fmtTokens(sig.beforeTokens)} ${glyphs.arrowRight} ${fmtTokens(sig.afterTokens)}`);
  } else if (sig.beforeTokens !== undefined) {
    parts.push(`from ${fmtTokens(sig.beforeTokens)}`);
  } else if (sig.afterTokens !== undefined) {
    parts.push(`to ${fmtTokens(sig.afterTokens)}`);
  }
  if (sig.preservedTopics !== undefined && sig.preservedTopics.length > 0) {
    parts.push(`kept: ${String(sig.preservedTopics.length)} topic${sig.preservedTopics.length === 1 ? '' : 's'}`);
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
};

/**
 * Dedented lifecycle-boundary marker for `context-compacted` signals. Rendered inline with the
 * surrounding signal stream but pulled left of the signal label column with a negative
 * `marginLeft` — visually marks a boundary rather than another per-task entry. Uses
 * `inkColors.muted` so it never competes for attention with semantic-state signals (success /
 * warning / error). The body shares the same `flexGrow` + `wrap="truncate-end"` shape as
 * {@link SignalLine} so on narrow terminals the topic / token text ellides instead of wrapping.
 *
 * Layout note: the parent `<Box paddingLeft={2}>` indents the signal column by 2 chars; the
 * `marginLeft={-2}` here cancels that indent so the marker lines up with the un-indented
 * "signals" header row above. The dot triplet (`· · ·`) and `dimColor` make it read as a
 * separator at a glance.
 */
const CompactionMarker = ({ signal }: { readonly signal: ContextCompactedSignal }): React.JSX.Element => {
  const detail = formatCompactionDetail(signal);
  return (
    <Box marginLeft={-2}>
      <Text dimColor>{fmtIsoTime(String(signal.timestamp))}</Text>
      <Text color={inkColors.muted}>
        {'  '}
        {glyphs.bullet} {glyphs.bullet} {glyphs.bullet} context compacted
      </Text>
      {detail !== undefined && (
        <Box flexGrow={1} flexShrink={1}>
          <Text color={inkColors.muted} wrap="truncate-end">
            {' ('}
            {detail}
            {')'}
          </Text>
        </Box>
      )}
    </Box>
  );
};

/**
 * Dispatch from a signal to its renderer: `context-compacted` → dedented {@link CompactionMarker};
 * everything else → the default {@link SignalLine}. Returns `null` for signals that have no row
 * form (e.g. `evaluation`, which is rendered by the dedicated {@link EvaluationLine}).
 */
const StreamSignalRow = ({ signal }: { readonly signal: HarnessSignal }): React.JSX.Element | null => {
  if (signal.type === 'context-compacted') return <CompactionMarker signal={signal} />;
  return <SignalLine signal={signal} />;
};

/**
 * One-row inline kinds bar — colored signal-kind labels for kinds that have actually appeared
 * in the bucketed signals so far. Replaces the prior 6-row static legend; full descriptions
 * live in the help overlay's Signals reference. Suppressed entirely when no task carries any
 * signals yet — avoids a flicker of empty row on mount.
 *
 * Kinds are derived from the union of every per-task signal label plus every orphan signal
 * label, deduped, and ordered by first appearance. Reads {@link SIGNAL_LABEL_COLOR} for the
 * colour swatch — the help overlay reads the same map, so the two surfaces stay in sync.
 */
const InlineKindsBar = ({ kinds }: { readonly kinds: readonly string[] }): React.JSX.Element | null => {
  if (kinds.length === 0) return null;
  return (
    <Box marginBottom={spacing.section}>
      <Text dimColor>{glyphs.bullet} kinds:</Text>
      {kinds.map((kind) => (
        <Text key={kind} color={SIGNAL_LABEL_COLOR[kind] ?? inkColors.info} bold>
          {'  '}
          {kind}
        </Text>
      ))}
    </Box>
  );
};

const collectKinds = (bucketed: BucketedExecution): readonly string[] => {
  const seen = new Set<string>();
  const order: string[] = [];
  const visit = (sig: HarnessSignal): void => {
    const row = rowForSignal(sig);
    if (row === undefined) return;
    if (seen.has(row.label)) return;
    seen.add(row.label);
    order.push(row.label);
  };
  for (const task of bucketed.tasks) for (const sig of task.signals) visit(sig);
  for (const sig of bucketed.orphanSignals) visit(sig);
  return order;
};

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

/**
 * User-facing label for an {@link AbortCause}. `undefined` means "omit the parenthetical" —
 * we don't show `(unknown)` because it adds noise without adding information. Keeping this in
 * tasks-panel rather than under domain/ because it's purely a TUI concern (the same cause
 * surfaces in chain.log with its raw discriminator).
 */
const abortCauseLabel = (cause: AbortCause): string | undefined => {
  switch (cause) {
    case 'user-cancel':
      return 'Ctrl-C';
    case 'sigterm':
      return 'SIGTERM';
    case 'watchdog-killed':
      return 'watchdog timeout';
    case 'rate-limit-exhausted':
      return 'rate limit';
    case 'process-crash':
      return 'process crash';
    case 'unknown':
      return undefined;
  }
};

const RecoveryLine = ({
  attemptN,
  context,
}: {
  readonly attemptN: number;
  readonly context: RecoveryContext;
}): React.JSX.Element => {
  // HH:MM from the ISO timestamp — keep `fmtIsoTime` for the seconds-precise variant; the
  // resume banner shows wall-clock at minute granularity to match what a user sees on a
  // sprint header (we don't need to know that the abort settled at 19:41:07.123).
  const hhmm = String(context.abortedAt).slice(11, 16);
  const label = abortCauseLabel(context.cause);
  return (
    <Box paddingLeft={2}>
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

const SubStepLine = ({ sub, running }: { readonly sub: TaskSubStep; readonly running: boolean }): React.JSX.Element => {
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
        <Box flexGrow={1} flexShrink={1}>
          <Text color={inkColors.error} wrap="truncate-end">
            {' '}
            {glyphs.emDash} {collapseWhitespace(sub.errorMessage)}
          </Text>
        </Box>
      )}
    </Box>
  );
};

const TaskBlock = ({
  task,
  running,
  display,
  maxSignals,
  maxSubSteps,
  maxEvaluations,
  recovering,
}: {
  readonly task: TaskBucket;
  readonly running: boolean;
  readonly display: string;
  readonly maxSignals: number;
  readonly maxSubSteps: number;
  readonly maxEvaluations: number;
  readonly recovering?: RecoveryContext;
}): React.JSX.Element => {
  const presentation = STATUS_PRESENTATION[task.status];
  const isSpinning = task.status === 'running';
  const signalRows = task.signals.slice(-maxSignals);
  const subStepRows = task.subSteps.slice(-maxSubSteps);
  const subStepElided = task.subSteps.length - subStepRows.length;
  const evalRows = task.evaluations.slice(-maxEvaluations);
  const evalElided = task.evaluations.length - evalRows.length;
  return (
    <Box flexDirection="column" marginBottom={spacing.section}>
      <Box>
        {isSpinning ? (
          <Spinner active={running} color={presentation.color} />
        ) : (
          <Text color={presentation.color} bold>
            {presentation.glyph}
          </Text>
        )}
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
      {recovering !== undefined && <RecoveryLine attemptN={recovering.fromAttemptN + 1} context={recovering} />}
      {task.errorMessage !== undefined && (
        <Box paddingLeft={2}>
          <Text color={inkColors.error}>{task.errorMessage}</Text>
        </Box>
      )}
      {subStepRows.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {subStepElided > 0 && <Text dimColor>{`… ${String(subStepElided)} earlier sub-steps`}</Text>}
          {subStepRows.map((s, i) => (
            <SubStepLine key={`${task.id}-sub-${String(i)}`} sub={s} running={running} />
          ))}
        </Box>
      )}
      {evalRows.length > 0 && (
        <Box flexDirection="column" paddingLeft={2} marginTop={1}>
          {evalElided > 0 && <Text dimColor>{`… ${String(evalElided)} earlier evaluations`}</Text>}
          {evalRows.map((e, i) => (
            <EvaluationLine key={`${task.id}-eval-${String(i)}`} evaluation={e} />
          ))}
        </Box>
      )}
      {signalRows.length > 0 && (
        <Box flexDirection="column" paddingLeft={2} marginTop={1}>
          <Text dimColor>signals</Text>
          <Box flexDirection="column" paddingLeft={2}>
            {signalRows.map((s, i) => (
              <StreamSignalRow key={`${task.id}-sig-${String(i)}`} signal={s} />
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
          <StreamSignalRow key={`orphan-${String(i)}`} signal={s} />
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
  maxSubStepsPerTask = 12,
  maxEvaluationsPerTask = 6,
  recoveringByTaskId,
}: TasksPanelProps): React.JSX.Element => {
  if (bucketed.tasks.length === 0 && bucketed.orphanSignals.length === 0) {
    return (
      <Box paddingX={spacing.indent}>
        <Text dimColor>(no tasks yet)</Text>
      </Box>
    );
  }
  const kinds = collectKinds(bucketed);
  return (
    <Box flexDirection="column" paddingX={spacing.indent}>
      <InlineKindsBar kinds={kinds} />
      <OrphanSignals signals={bucketed.orphanSignals} max={maxOrphanSignals} />
      {bucketed.tasks.map((task) => {
        // Deliberate stylistic 8-char short-uuid fallback (NOT a width-driven clip) — keeps
        // the header readable when the launcher hasn't supplied a friendly name. The friendly
        // name path goes through `nameById` and renders verbatim; if a future design makes
        // the name itself overflow, wrap that path in a `<Box flexGrow>` + `wrap="truncate-end"`.
        const display = nameById?.get(task.id) ?? `${task.id.slice(0, 8)}…`;
        const recovering = recoveringByTaskId?.get(task.id);
        return (
          <TaskBlock
            key={task.id}
            task={task}
            running={running}
            display={display}
            maxSignals={maxSignalsPerTask}
            maxSubSteps={maxSubStepsPerTask}
            maxEvaluations={maxEvaluationsPerTask}
            {...(recovering !== undefined ? { recovering } : {})}
          />
        );
      })}
    </Box>
  );
};
