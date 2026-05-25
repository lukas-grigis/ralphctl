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

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type {
  BucketedExecution,
  TaskBucket,
  TaskSubStep,
  TaskBucketStatus,
} from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { SprintState, TaskProjection } from '@src/application/ui/tui/components/tasks-projection.ts';
import type { AbortCause, RecoveryContext } from '@src/domain/entity/attempt.ts';
import type {
  CommitMessageSignal,
  ContextCompactedSignal,
  EvaluationSignal,
  HarnessSignal,
} from '@src/domain/signal.ts';
import { glyphFor, glyphs, inkColors, spacing, type SignalKind } from '@src/application/ui/tui/theme/tokens.ts';
import { useNoColor } from '@src/application/ui/tui/runtime/use-no-color.ts';
import { fmtDuration, fmtIsoTime } from '@src/application/ui/tui/theme/duration.ts';
import { EvaluatorFailurePanel } from '@src/application/ui/tui/components/evaluator-failure-panel.tsx';
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
   * When `true` the panel claims keyboard input for row-cursor navigation (j/k or ↑/↓) and
   * row expansion (Enter / Space). Defaults to `false` so unit tests that render the panel in
   * isolation don't compete with any other `useInput` handler in the same Ink tree. The
   * Implement view sets this `true` while the run is live and no overlay is open.
   *
   * The cursor traverses the flat sequence of visible signal rows (orphans first, then each
   * task in order). When focused on a `commit-message` row, Enter / Space toggles expansion to
   * reveal the body. The subject row shows the AI-proposed subject; the harness-appended
   * ` (#123, !456)` ref suffix lands at `git commit -F` time and is not threaded back onto the
   * signal. Expansion state lives in panel-local
   * `useState` so it persists across re-renders within the session but resets if the panel
   * unmounts (e.g. on `D` detach back to home).
   */
  readonly inputActive?: boolean;
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
  /**
   * Map of task id → `verificationCriteria` bullets, sourced directly from `Task.verificationCriteria`
   * by the host view (no disk read, no async loader). When supplied, each non-pending task's
   * header renders a collapsed 3-line summary of the criteria with a `press e to expand` hint;
   * pressing `e` while the panel owns input toggles the active task's full criteria block.
   *
   * Audit [05]: replaces the prior `readDoneCriteria` lazy loader that read from a now-deleted
   * `<sprintDir>/implement/<task-id>/done-criteria.md`. The criteria live on the task entity,
   * the view already polls those entities, and the file is gone.
   */
  readonly taskCriteriaById?: ReadonlyMap<string, readonly string[]>;
  /**
   * Dev-only flag — when `true`, failing evaluator rows render via
   * {@link EvaluatorFailurePanel} (per-dimension colour-coded view + critique excerpt with
   * expand affordance) instead of the canonical single-line summary. Defaults `false` so
   * production keeps the existing 4-line dimension summary until the per-dimension panel is
   * promoted out of the developer-flag gate. Threaded from `settings.developer
   * .showEvaluatorFailureUI` by the launcher.
   */
  readonly showEvaluatorFailureUI?: boolean;
  /**
   * Optional projected sprint state. When supplied the per-task header appends an ETA derived
   * from `state.tasks[i].medianRoundDurationMs * (max - currentRound)`. Absent ⇒ ETA is
   * silently omitted (the existing `round N/M` rendering is unchanged). The view is the source
   * of truth for whether to project: tests render TasksPanel in isolation without a projection,
   * and the live dashboard threads it once `taskState` is polled.
   */
  readonly sprintState?: SprintState;
  /**
   * Wall-clock reference in milliseconds — used by the idle-ticker to compute the gap between
   * the latest stream signal and "now". The execute view polls every 1s and passes the latest
   * `Date.now()`; tests pass a fixed value. Defaults to `Date.now()` at render-time so
   * isolated unit renders work without explicit wiring (no ticker fires without elapsed gap).
   */
  readonly nowMs?: number;
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
      // The subject is the source of truth — the harness owns the trailer-appending logic and
      // re-emits the signal with the resolved body, but the subject is what reviewers read first
      // and what `git log --oneline` shows. Body + trailers are revealed by the
      // `<CommitSignalLine>` collapsible row when the user expands the focused row.
      return { label: 'commit', text: sig.subject };
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

/**
 * Disclosure markers for collapsible commit-message rows. Glyphs chosen for clear visual
 * affinity (right-pointing → collapsed, down-pointing → expanded) and Unicode coverage in the
 * vt220 / Powerline glyph families every modern terminal emulator ships.
 */
const COLLAPSED_DISCLOSURE = '▸';
const EXPANDED_DISCLOSURE = '▾';
/** Cursor caret for the focused signal row. Same vocabulary as the global action cursor. */
const FOCUS_CURSOR = '›';

const SignalLine = ({
  signal,
  focused = false,
}: {
  readonly signal: HarnessSignal;
  readonly focused?: boolean;
}): React.JSX.Element | null => {
  // NB hook call runs unconditionally — `useNoColor` is read before the early return below
  // so the rules-of-hooks lint stays clean even when `rowForSignal` returns undefined.
  const noColor = useNoColor();
  const row = rowForSignal(signal);
  if (row === undefined) return null;
  const color = SIGNAL_LABEL_COLOR[row.label] ?? inkColors.info;
  // Shape backup — when NO_COLOR is in effect the colour swatch on the label disappears, so
  // prefix the label with a per-kind glyph (`+` change, `~` learning, `■` commit, …). The
  // glyph reads as a visual prefix without consuming the body column. `glyphFor` returns the
  // empty string for kinds whose label already self-discriminates (`progress`, `done`, …).
  const shapeGlyph = noColor ? glyphFor(row.label as SignalKind) : '';
  // Layout: fixed timestamp + fixed label column + flex-grow body that ellides on the
  // terminal's actual width via Ink's `wrap="truncate-end"`. The body is a row that may
  // shrink (so long messages don't push the layout); the label box is fixed-width and never
  // shrinks. Collapsing whitespace on the body line keeps multi-line payloads readable as a
  // single ellided row — for `commit-message` the full body + trailer is reached via the
  // separate {@link CommitSignalLine} collapsible variant.
  return (
    <Box>
      <Text color={focused ? inkColors.highlight : inkColors.muted} bold={focused}>
        {focused ? FOCUS_CURSOR : ' '}{' '}
      </Text>
      <Text dimColor>{fmtIsoTime(String(signal.timestamp))}</Text>
      <Text color={color} bold>
        {'  '}
        {shapeGlyph !== '' ? `${shapeGlyph} ${padLabel(row.label)}` : padLabel(row.label)}
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
 * Collapsible variant for `commit-message` signals. Default state is collapsed: only the
 * commit subject line shows, identical in layout to {@link SignalLine}. When expanded (the
 * row is focused and the user pressed Enter / Space), the body paragraphs render indented
 * under the signal label column.
 *
 * Source of truth for the multi-line body is `signal.body` when present. The harness-appended
 * ` (#123, !456)` subject suffix is added by the commit-task leaf when calling `git commit -F`
 * but is not threaded back onto the signal — the TUI shows the AI's proposed message, not the
 * post-suffix resolved form.
 *
 * Width handling: every body line uses the same `wrap="truncate-end"` discipline as the
 * subject row, so a 200-col commit body still ellides cleanly at narrow widths instead of
 * exploding the layout.
 */
const CommitSignalLine = ({
  signal,
  focused,
  expanded,
}: {
  readonly signal: CommitMessageSignal;
  readonly focused: boolean;
  readonly expanded: boolean;
}): React.JSX.Element => {
  const headline = signal.subject;
  const color = SIGNAL_LABEL_COLOR['commit'] ?? inkColors.info;
  // Lines below the subject — body paragraphs — derived from `signal.body`. We trim leading
  // / trailing blanks but preserve interior blank lines so the body's paragraph structure
  // survives.
  const tailLines = useMemo<readonly string[]>(() => {
    const body = signal.body;
    if (body === undefined || body.length === 0) return [];
    const parts = body.split('\n');
    let start = 0;
    let end = parts.length;
    while (start < end && parts[start]?.trim() === '') start += 1;
    while (end > start && parts[end - 1]?.trim() === '') end -= 1;
    return parts.slice(start, end);
  }, [signal.body]);
  const canExpand = tailLines.length > 0;
  const disclosure = canExpand ? (expanded ? EXPANDED_DISCLOSURE : COLLAPSED_DISCLOSURE) : ' ';
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={focused ? inkColors.highlight : inkColors.muted} bold={focused}>
          {focused ? FOCUS_CURSOR : ' '}{' '}
        </Text>
        <Text dimColor>{fmtIsoTime(String(signal.timestamp))}</Text>
        <Text color={color} bold>
          {disclosure} {padLabel('commit')}
        </Text>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">{collapseWhitespace(headline)}</Text>
        </Box>
      </Box>
      {expanded && canExpand && (
        // Indent under the signal label column so the body visually nests beneath its subject.
        // The label column width is the cursor (2) + timestamp (5: "HH:MM") + 2-char gap + the
        // padded label width — but rather than pin a magic number, use a single
        // `paddingLeft={spacing.indent * 4}` which lines up with the start of the body column
        // at a glance without needing to mirror the exact pixel-grid.
        <Box flexDirection="column" paddingLeft={spacing.indent * 4}>
          {tailLines.map((line, i) => (
            <Box key={`tail-${String(i)}`}>
              <Box flexGrow={1} flexShrink={1}>
                <Text dimColor={line.trim() === ''} wrap="truncate-end">
                  {line.length === 0 ? ' ' : line}
                </Text>
              </Box>
            </Box>
          ))}
        </Box>
      )}
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
 * `commit-message` → collapsible {@link CommitSignalLine}; everything else → the default
 * {@link SignalLine}. Returns `null` for signals that have no row form (e.g. `evaluation`, which
 * is rendered by the dedicated {@link EvaluationLine}).
 */
const StreamSignalRow = ({
  signal,
  focused,
  expanded,
}: {
  readonly signal: HarnessSignal;
  readonly focused: boolean;
  readonly expanded: boolean;
}): React.JSX.Element | null => {
  if (signal.type === 'context-compacted') return <CompactionMarker signal={signal} />;
  if (signal.type === 'commit-message')
    return <CommitSignalLine signal={signal} focused={focused} expanded={expanded} />;
  return <SignalLine signal={signal} focused={focused} />;
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

// `parseCriteriaBullets` was deleted in audit [05] — the panel now receives the bullet array
// directly from the host via `taskCriteriaById`, sourced from `Task.verificationCriteria`.

/**
 * Per-criterion verdict mapping is deterministic only when the criterion count and the
 * evaluator's dimension count match — in that case we pair them positionally, which is what
 * the AI prompt already encourages. When counts diverge, we fall back to the per-dimension
 * row rendering rather than fabricate attribution. Returns the rendered text bullets, one
 * per criterion, paired with the dimension's pass flag.
 */
interface CriterionVerdictRow {
  readonly criterion: string;
  readonly passed: boolean;
}

const fuseCriteriaWithDimensions = (
  criteria: readonly string[],
  dimensions: EvaluationSignal['dimensions']
): readonly CriterionVerdictRow[] | undefined => {
  if (criteria.length === 0 || dimensions.length === 0) return undefined;
  if (criteria.length !== dimensions.length) return undefined;
  const out: CriterionVerdictRow[] = [];
  for (let i = 0; i < criteria.length; i += 1) {
    const c = criteria[i];
    const d = dimensions[i];
    if (c === undefined || d === undefined) return undefined;
    out.push({ criterion: c, passed: d.passed });
  }
  return out;
};

const EvaluationLine = ({
  evaluation,
  criteria,
}: {
  readonly evaluation: EvaluationSignal;
  readonly criteria?: readonly string[];
}): React.JSX.Element => {
  const color =
    evaluation.status === 'passed'
      ? inkColors.success
      : evaluation.status === 'failed'
        ? inkColors.error
        : inkColors.warning;
  const fused = criteria !== undefined ? fuseCriteriaWithDimensions(criteria, evaluation.dimensions) : undefined;
  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>{fmtIsoTime(String(evaluation.timestamp))}</Text>
        <Text color={color} bold>
          {'  '}eval{'  '}
        </Text>
        <Text bold>{evaluation.status}</Text>
      </Box>
      {fused !== undefined ? (
        // Per-criterion attribution: one row per criterion, each ellided on width so a long
        // criterion line never explodes the layout. Pass / fail glyph at the head matches the
        // paired dimension's `passed` flag.
        <Box flexDirection="column" paddingLeft={6}>
          {fused.map((row, i) => (
            <Box key={`crit-${String(i)}`}>
              <Text color={row.passed ? inkColors.success : inkColors.error} bold>
                {row.passed ? glyphs.check : glyphs.cross}
              </Text>
              <Text> </Text>
              <Box flexGrow={1} flexShrink={1}>
                <Text wrap="truncate-end">{collapseWhitespace(row.criterion)}</Text>
              </Box>
            </Box>
          ))}
        </Box>
      ) : (
        evaluation.dimensions.length > 0 && (
          <Box paddingLeft={6}>
            <Text dimColor>
              {evaluation.dimensions
                .map((d) => `${d.dimension}: ${d.passed ? glyphs.check : glyphs.cross}`)
                .join(`  ${glyphs.bullet}  `)}
            </Text>
          </Box>
        )
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

/**
 * Build a stable focusable-row key. Composed of `scope:absoluteIndex` where `scope` is either
 * the literal string `orphan` or a task id (uuid v7). Absolute index is the signal's position
 * in the original (unsliced) signal array — surviving the slice means the key stays valid even
 * when newer signals push older ones off the visible window.
 */
const focusKey = (scope: string, absoluteIndex: number): string => `${scope}:${String(absoluteIndex)}`;

/**
 * Predicate: is this signal type focusable in the cursor model? Non-focusable signals are
 * either rendered by a dedicated component outside the signal stream (evaluation) or render as
 * a dedented lifecycle boundary (context-compacted) where focus would feel out of place.
 */
const isFocusable = (sig: HarnessSignal): boolean => sig.type !== 'evaluation' && sig.type !== 'context-compacted';

/** Build the visible row keys for one scope's signal slice. */
const focusKeysForSlice = (scope: string, signals: readonly HarnessSignal[], sliceStart: number): readonly string[] => {
  const out: string[] = [];
  for (let i = 0; i < signals.length; i += 1) {
    const sig = signals[i];
    if (sig === undefined) continue;
    if (isFocusable(sig)) out.push(focusKey(scope, sliceStart + i));
  }
  return out;
};

/**
 * Format an ETA (milliseconds remaining) as `~Xm Ys`. For sub-minute durations the minutes
 * field is omitted; the result is `~Ys`. Negative / NaN values degrade to `undefined` so the
 * header renders no ETA chip at all rather than misleading "negative time remaining" text.
 */
const fmtEta = (ms: number): string | undefined => {
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `~${String(s)}s`;
  return `~${String(m)}m ${String(s).padStart(2, '0')}s`;
};

/**
 * Derive ETA text for the active-task header from the projected task. The estimate uses the
 * median settled round duration over the remaining rounds in the gen-eval loop. Returns the
 * pre-formatted string `· ~Xm Ys remaining` ready to splice into the header, or
 * `· no ETA yet` when the projection has no median yet (first round of first task, or any
 * task whose attempts haven't settled). When the cap is already reached, returns `undefined`
 * so the chip is dropped instead of stale.
 */
const formatEtaChip = (
  projection: TaskProjection | undefined,
  currentRound: number,
  maxRounds: number | undefined
): string | undefined => {
  if (projection === undefined) return undefined;
  if (maxRounds === undefined || maxRounds <= 0) return undefined;
  const remaining = Math.max(0, maxRounds - Math.max(0, currentRound));
  if (remaining === 0) return undefined;
  const median = projection.medianRoundDurationMs;
  if (median === undefined || median <= 0) {
    return `${glyphs.bullet} no ETA yet`;
  }
  const text = fmtEta(median * remaining);
  if (text === undefined) return undefined;
  return `${glyphs.bullet} ${text} remaining`;
};

/**
 * Idle-ticker threshold: render the muted ticker line when the active task is `running` AND
 * the latest stream signal is older than this many milliseconds. Calibrated for the user's
 * perceptual "is anything happening" window — a 5 s gap is normal between tool calls; 10 s
 * starts to feel quiet.
 */
const IDLE_TICKER_THRESHOLD_MS = 10_000;

/**
 * Walk a task's signal list right-to-left and collect the last 1–2 `note` / `learning`
 * signals' bodies. Returns the texts in newest-first order so the renderer can show a
 * compact "last + previous" pair. Empty when the task has no such signal — the ticker then
 * suppresses itself entirely rather than fabricating placeholder text.
 */
const latestIdleSnippets = (signals: readonly HarnessSignal[]): readonly string[] => {
  const out: string[] = [];
  for (let i = signals.length - 1; i >= 0 && out.length < 2; i -= 1) {
    const s = signals[i];
    if (s === undefined) continue;
    if (s.type === 'note') out.push(s.text);
    else if (s.type === 'learning') out.push(s.text);
  }
  return out;
};

/**
 * Number of criterion bullets to render in the collapsed-summary form. Three lines reads as a
 * glance preview without becoming a wall of text on tasks with many criteria; expanding via
 * `e` reveals the rest.
 */
const CRITERIA_COLLAPSED_LINES = 3;

const CriteriaBlock = ({
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
    <Box flexDirection="column" paddingLeft={2}>
      <Box>
        <Text dimColor>{glyphs.bullet} criteria</Text>
        {!expanded && bullets.length > CRITERIA_COLLAPSED_LINES && (
          <Text dimColor> {glyphs.bullet} press e to expand</Text>
        )}
        {expanded && bullets.length > CRITERIA_COLLAPSED_LINES && (
          <Text dimColor> {glyphs.bullet} press e to collapse</Text>
        )}
      </Box>
      <Box flexDirection="column" paddingLeft={2}>
        {visible.map((b, i) => (
          <Box key={`crit-row-${String(i)}`}>
            <Text dimColor>{glyphs.bullet} </Text>
            <Box flexGrow={1} flexShrink={1}>
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

const TaskBlock = ({
  task,
  running,
  display,
  maxSignals,
  maxSubSteps,
  maxEvaluations,
  recovering,
  focusedKey,
  expandedKeys,
  scopeId,
  sliceStart,
  taskCriteria,
  criteriaExpanded,
  showEvaluatorFailureUI,
  taskProjection,
  isActive,
  firstRun,
  cardExpanded,
  cardFocused,
  nowMs,
}: {
  readonly task: TaskBucket;
  readonly running: boolean;
  readonly display: string;
  readonly maxSignals: number;
  readonly maxSubSteps: number;
  readonly maxEvaluations: number;
  readonly recovering?: RecoveryContext;
  readonly focusedKey: string | undefined;
  readonly expandedKeys: ReadonlySet<string>;
  readonly scopeId: string;
  /** Absolute signal index where the rendered slice starts (`task.signals.length - sliceLen`). */
  readonly sliceStart: number;
  /** Pre-resolved verification criteria for this task (audit [05]) — supplied by the host. */
  readonly taskCriteria?: readonly string[];
  /** When true the criteria block renders all bullets; otherwise the 3-line summary. */
  readonly criteriaExpanded: boolean;
  /** Dev flag — opt into the EvaluatorFailurePanel for failed evaluations. */
  readonly showEvaluatorFailureUI: boolean;
  /** Projected task entry — sourced from `sprintState.tasks` when available. */
  readonly taskProjection?: TaskProjection;
  /** True for the active (running) task; gates ETA rendering to the operator's focus. */
  readonly isActive: boolean;
  /**
   * Run-wide first-run flag — true when no harness signal or evaluation has fired across any
   * task in the panel. Surfaces a `waiting for first attempt…` line below the active task's
   * spinner so the operator sees the run is alive but pre-signal.
   */
  readonly firstRun: boolean;
  /**
   * When `true` the full card body (criteria, sub-steps, evaluations, signals) renders. When
   * `false` only the one-line header summary is shown — the operator expands by focusing the
   * card cursor and pressing Enter / Space.
   */
  readonly cardExpanded: boolean;
  /** Card-level focus indicator — drives the leading cursor caret on the header row. */
  readonly cardFocused: boolean;
  /** Wall-clock reference for the idle ticker (current time, ms epoch). */
  readonly nowMs: number;
}): React.JSX.Element => {
  const presentation = STATUS_PRESENTATION[task.status];
  const isSpinning = task.status === 'running';
  const signalRows = task.signals.slice(-maxSignals);
  const signalsElided = task.signals.length - signalRows.length;
  const subStepRows = task.subSteps.slice(-maxSubSteps);
  const subStepElided = task.subSteps.length - subStepRows.length;
  const evalRows = task.evaluations.slice(-maxEvaluations);
  const evalElided = task.evaluations.length - evalRows.length;
  const criteriaBullets = taskCriteria;
  // Most recent commit SHA for the collapsed summary line — sourced from the projection's
  // lastAttempt when a TaskProjection is supplied. Truncated to 7 chars (git's `--short`
  // default).
  const latestCommitSha = useMemo<string | undefined>(() => {
    const sha = taskProjection?.lastAttempt?.commitSha;
    return sha !== undefined ? String(sha).slice(0, 7) : undefined;
  }, [taskProjection]);
  const attemptsCount = taskProjection?.attemptsCount ?? 0;
  // Idle ticker — surfaces the last 1–2 note / learning signals when the task is running and
  // the most recent stream signal is older than IDLE_TICKER_THRESHOLD_MS. Provides reassurance
  // that the harness is alive during long tool calls; hides immediately when a new signal
  // lands. Active task only — completed / blocked cards have no use for "what's the AI been
  // thinking about" hints.
  const idleSnippets = useMemo<readonly string[]>(() => {
    if (!isActive || !isSpinning) return [];
    const latest = task.signals[task.signals.length - 1];
    if (latest === undefined) return [];
    const latestMs = new Date(String(latest.timestamp)).getTime();
    if (!Number.isFinite(latestMs)) return [];
    if (nowMs - latestMs < IDLE_TICKER_THRESHOLD_MS) return [];
    return latestIdleSnippets(task.signals);
  }, [task.signals, isActive, isSpinning, nowMs]);
  return (
    <Box flexDirection="column" marginBottom={spacing.section}>
      <Box>
        <Text color={cardFocused ? inkColors.highlight : inkColors.muted} bold={cardFocused}>
          {cardFocused ? FOCUS_CURSOR : ' '}{' '}
        </Text>
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
        {!cardExpanded && attemptsCount > 0 && (
          <Text dimColor>
            {' '}
            {glyphs.bullet} {String(attemptsCount)}×
          </Text>
        )}
        {!cardExpanded && latestCommitSha !== undefined && (
          <Text dimColor>
            {' '}
            {glyphs.bullet} {latestCommitSha}
          </Text>
        )}
        {cardExpanded && task.genEvalRound !== undefined && task.genEvalRound > 0 && (
          <Text color={inkColors.info}>
            {' '}
            {glyphs.bullet} round {String(task.genEvalRound)}
            {task.genEvalMaxRounds !== undefined ? `/${String(task.genEvalMaxRounds)}` : ''}
          </Text>
        )}
        {cardExpanded &&
          isActive &&
          task.genEvalRound !== undefined &&
          task.genEvalRound > 0 &&
          (() => {
            const eta = formatEtaChip(taskProjection, task.genEvalRound, task.genEvalMaxRounds);
            if (eta === undefined) return null;
            return <Text dimColor> {eta}</Text>;
          })()}
      </Box>
      {cardExpanded && idleSnippets.length > 0 && (
        <Box paddingLeft={2}>
          <Box flexGrow={1} flexShrink={1}>
            <Text dimColor wrap="truncate-end">
              {glyphs.activityArrow} {idleSnippets.map((s) => collapseWhitespace(s)).join(`  ${glyphs.bullet}  `)}
            </Text>
          </Box>
        </Box>
      )}
      {cardExpanded && recovering !== undefined && (
        <RecoveryLine attemptN={recovering.fromAttemptN + 1} context={recovering} />
      )}
      {cardExpanded && firstRun && isActive && isSpinning && (
        <Box paddingLeft={2}>
          <Text dimColor>{glyphs.activityArrow} waiting for first attempt…</Text>
        </Box>
      )}
      {cardExpanded && criteriaBullets !== undefined && criteriaBullets.length > 0 && (
        <CriteriaBlock bullets={criteriaBullets} expanded={criteriaExpanded} />
      )}
      {cardExpanded && task.errorMessage !== undefined && (
        <Box paddingLeft={2}>
          <Text color={inkColors.error}>{task.errorMessage}</Text>
        </Box>
      )}
      {cardExpanded && subStepRows.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {subStepElided > 0 && (
            <Text dimColor>{`${glyphs.clipEllipsis} ${String(subStepElided)} earlier sub-steps`}</Text>
          )}
          {subStepRows.map((s, i) => (
            <SubStepLine key={`${task.id}-sub-${String(i)}`} sub={s} running={running} />
          ))}
        </Box>
      )}
      {cardExpanded && evalRows.length > 0 && (
        <Box flexDirection="column" paddingLeft={2} marginTop={1}>
          {evalElided > 0 && <Text dimColor>{`${glyphs.clipEllipsis} ${String(evalElided)} earlier evaluations`}</Text>}
          {evalRows.map((e, i) => {
            // Dev-gated: failed evaluations render via the dedicated per-dimension panel when
            // the flag is on. Anything else (passed / malformed) keeps the canonical compact
            // line so we don't disrupt the existing layout. `isFinalRound` is approximated as
            // "this is the latest evaluation row AND the task is still running" — only then
            // will the harness feed the critique into another round.
            const isLatest = i === evalRows.length - 1;
            const willGetAnotherRound = isLatest && task.status === 'running';
            if (showEvaluatorFailureUI && e.status === 'failed') {
              return (
                <EvaluatorFailurePanel
                  key={`${task.id}-eval-${String(i)}`}
                  evaluation={e}
                  isFinalRound={!willGetAnotherRound}
                />
              );
            }
            return (
              <EvaluationLine
                key={`${task.id}-eval-${String(i)}`}
                evaluation={e}
                {...(criteriaBullets !== undefined ? { criteria: criteriaBullets } : {})}
              />
            );
          })}
        </Box>
      )}
      {cardExpanded && signalRows.length > 0 && (
        <Box flexDirection="column" paddingLeft={2} marginTop={1}>
          <Text dimColor>signals</Text>
          <Box flexDirection="column" paddingLeft={2}>
            {signalsElided > 0 && (
              <Text
                dimColor
              >{`${glyphs.clipEllipsis} ${String(signalsElided)} earlier signal${signalsElided === 1 ? '' : 's'}`}</Text>
            )}
            {signalRows.map((s, i) => {
              const key = focusKey(scopeId, sliceStart + i);
              return (
                <StreamSignalRow
                  key={`${task.id}-sig-${String(sliceStart + i)}`}
                  signal={s}
                  focused={focusedKey === key}
                  expanded={expandedKeys.has(key)}
                />
              );
            })}
          </Box>
        </Box>
      )}
    </Box>
  );
};

const OrphanSignals = ({
  signals,
  max,
  focusedKey,
  expandedKeys,
  sliceStart,
}: {
  readonly signals: readonly HarnessSignal[];
  readonly max: number;
  readonly focusedKey: string | undefined;
  readonly expandedKeys: ReadonlySet<string>;
  /** Absolute signal index where the rendered slice starts. */
  readonly sliceStart: number;
}): React.JSX.Element | null => {
  if (signals.length === 0) return null;
  const rows = signals.slice(-max);
  // Display-clip marker (audit-[03]): when the orphan-signals list is longer than the
  // render budget, surface the count of elided rows so the operator knows earlier notes
  // exist beyond the window.
  const orphansElided = signals.length - rows.length;
  return (
    <Box flexDirection="column" marginBottom={spacing.section}>
      <Text dimColor bold>
        {glyphs.bullet} Cross-task notes
      </Text>
      <Box flexDirection="column" paddingLeft={2}>
        {orphansElided > 0 && (
          <Text
            dimColor
          >{`${glyphs.clipEllipsis} ${String(orphansElided)} earlier note${orphansElided === 1 ? '' : 's'}`}</Text>
        )}
        {rows.map((s, i) => {
          const key = focusKey('orphan', sliceStart + i);
          return (
            <StreamSignalRow
              key={`orphan-${String(sliceStart + i)}`}
              signal={s}
              focused={focusedKey === key}
              expanded={expandedKeys.has(key)}
            />
          );
        })}
      </Box>
    </Box>
  );
};

/**
 * Compute the flat sequence of focusable row keys in render order: orphans first (matching
 * the on-screen ordering), then each task's visible signal slice. Keys are stable across
 * re-renders so a moving cursor doesn't jump when a new signal lands; non-focusable signals
 * (`evaluation`, `context-compacted`) are excluded from the cursor model but still render.
 */
const buildFlatFocusKeys = (
  bucketed: BucketedExecution,
  maxSignalsPerTask: number,
  maxOrphanSignals: number
): readonly string[] => {
  const keys: string[] = [];
  const orphanSliceLen = Math.min(bucketed.orphanSignals.length, maxOrphanSignals);
  const orphanSliceStart = bucketed.orphanSignals.length - orphanSliceLen;
  const orphanSlice = bucketed.orphanSignals.slice(-orphanSliceLen);
  for (const k of focusKeysForSlice('orphan', orphanSlice, orphanSliceStart)) keys.push(k);
  for (const task of bucketed.tasks) {
    const sliceLen = Math.min(task.signals.length, maxSignalsPerTask);
    const sliceStart = task.signals.length - sliceLen;
    const slice = task.signals.slice(-sliceLen);
    for (const k of focusKeysForSlice(task.id, slice, sliceStart)) keys.push(k);
  }
  return keys;
};

/** Test if a focus key points at a `commit-message` signal in the bucketed view. */
const isCommitMessageKey = (key: string, bucketed: BucketedExecution): boolean => {
  const sep = key.indexOf(':');
  if (sep < 0) return false;
  const scope = key.slice(0, sep);
  const idx = Number(key.slice(sep + 1));
  if (!Number.isFinite(idx)) return false;
  if (scope === 'orphan') {
    return bucketed.orphanSignals[idx]?.type === 'commit-message';
  }
  const task = bucketed.tasks.find((t) => t.id === scope);
  return task?.signals[idx]?.type === 'commit-message';
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
  inputActive = false,
  taskCriteriaById,
  showEvaluatorFailureUI = false,
  sprintState,
  nowMs,
}: TasksPanelProps): React.JSX.Element => {
  // Render-time fallback for the idle-ticker clock. The execute view passes a polled `now` so
  // the ticker can re-evaluate on each heartbeat; isolated unit renders fall through to this
  // default, which freezes the clock at mount-time and so naturally suppresses the ticker
  // unless a test explicitly supplies an old timestamp.
  const effectiveNowMs = nowMs ?? Date.now();
  const flatKeys = useMemo(
    () => buildFlatFocusKeys(bucketed, maxSignalsPerTask, maxOrphanSignals),
    [bucketed, maxSignalsPerTask, maxOrphanSignals]
  );

  // Cursor identity is the focused row's stable key (not its index). When a new signal lands
  // the index of the existing row may shift, but its key is unchanged, so the cursor sticks
  // to the same row. When the focused key falls off the visible slice (cap-elision), the
  // cursor collapses to `undefined` and Enter/Space re-anchors at the latest row.
  const [focusedKey, setFocusedKey] = useState<string | undefined>(undefined);
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set<string>());
  // No lazy hydration — `taskCriteriaById` is supplied synchronously by the host view from
  // `Task.verificationCriteria`. Empty array → render the placeholder; missing key (task not
  // yet in view's poll) → criteria UI is suppressed for that task.
  // Task ids whose criteria block is currently expanded (full bullet list). Default state is
  // the 3-line summary. Toggled by pressing `e` while the panel owns input.
  const [criteriaExpandedIds, setCriteriaExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  // The active (first non-completed) task — anchor for the `e` criteria hotkey AND the
  // default card-cursor position. Recomputed each render so the `useInput` callback always
  // sees the latest active id.
  const activeTaskIdx = bucketed.tasks.findIndex((t) => t.status !== 'completed');
  const activeTaskId = activeTaskIdx >= 0 ? bucketed.tasks[activeTaskIdx]?.id : undefined;

  // Per-task card expansion. The active (running) task auto-expands when it becomes active so
  // the operator's eye anchors on the live stream — but the user can collapse it with Esc or
  // Enter just like any other card. Other cards default collapsed to a one-line summary.
  // Initial state seeds the active task on mount so the very first paint already shows the
  // live stream (no `useEffect`-induced flicker).
  const [expandedTaskIds, setExpandedTaskIds] = useState<ReadonlySet<string>>(
    () => new Set(activeTaskId !== undefined ? [activeTaskId] : [])
  );
  // Card cursor — index into `bucketed.tasks`. Default `undefined` means "no manual focus
  // yet"; the panel anchors on the active task on first interaction.
  const [cardCursor, setCardCursor] = useState<number | undefined>(undefined);

  // No async hydration step — criteria flow synchronously from props.

  // Seed `expandedTaskIds` with the active task whenever it transitions to a new id (post-mount
  // transitions only — mount itself is handled by the lazy initial state). This gives the
  // auto-expand-on-activation UX without making the expansion permanent: once the active id is
  // in the set, Esc / Enter on it works the same as on any manually-expanded card.
  const prevActiveTaskIdRef = useRef<string | undefined>(activeTaskId);
  useEffect(() => {
    if (activeTaskId !== undefined && prevActiveTaskIdRef.current !== activeTaskId) {
      setExpandedTaskIds((prev) => {
        if (prev.has(activeTaskId)) return prev;
        const next = new Set(prev);
        next.add(activeTaskId);
        return next;
      });
    }
    prevActiveTaskIdRef.current = activeTaskId;
  }, [activeTaskId]);

  const isCardExpanded = (taskId: string): boolean => expandedTaskIds.has(taskId);

  // The card cursor — defaults to the active task on first render, falls back to the last
  // card when the active task no longer exists (e.g. the run has finished). Stays put across
  // re-renders so a moving cursor doesn't jump.
  const effectiveCardCursor = useMemo(() => {
    if (cardCursor !== undefined && cardCursor >= 0 && cardCursor < bucketed.tasks.length) return cardCursor;
    if (activeTaskIdx >= 0) return activeTaskIdx;
    return bucketed.tasks.length - 1;
  }, [cardCursor, activeTaskIdx, bucketed.tasks.length]);
  const focusedCardId = effectiveCardCursor >= 0 ? bucketed.tasks[effectiveCardCursor]?.id : undefined;
  const focusedCardExpanded = focusedCardId !== undefined ? isCardExpanded(focusedCardId) : false;

  const focusedIndex = focusedKey !== undefined ? flatKeys.indexOf(focusedKey) : -1;
  const effectiveFocusedKey = focusedIndex >= 0 ? focusedKey : undefined;

  useInput(
    (input, key) => {
      // Done-criteria toggle for the active task. Independent of the card / row cursors: the
      // operator is virtually always reading the running task when this hotkey is reached.
      if (input === 'e' && activeTaskId !== undefined) {
        setCriteriaExpandedIds((prev) => {
          const next = new Set(prev);
          if (next.has(activeTaskId)) next.delete(activeTaskId);
          else next.add(activeTaskId);
          return next;
        });
        return;
      }
      // Esc collapses an expanded focused card. Works on any expanded card, including the
      // active task — the auto-expand-on-activation seed only fires when the active id
      // transitions, so collapsing it stays collapsed until the next transition.
      if (key.escape) {
        if (focusedCardId !== undefined && expandedTaskIds.has(focusedCardId)) {
          setExpandedTaskIds((prev) => {
            const next = new Set(prev);
            next.delete(focusedCardId);
            return next;
          });
        }
        return;
      }
      // j / k AND ↑ / ↓ share one cursor; the scope shifts with the focused card's state and
      // the current row-cursor anchor:
      //   - collapsed card → card cursor moves between cards.
      //   - expanded card AND a row cursor is already anchored → row cursor moves within the
      //     card; jumping past either edge hands off to the card cursor (no need to collapse
      //     the card first).
      //   - expanded card with no row anchor yet → card cursor (lets the operator pan
      //     between cards without first clicking into a row).
      const rowCursorActive = focusedCardExpanded && flatKeys.length > 0 && focusedIndex >= 0;
      if (key.downArrow || input === 'j') {
        if (rowCursorActive) {
          if (focusedIndex < flatKeys.length - 1) {
            setFocusedKey(flatKeys[focusedIndex + 1]);
            return;
          }
          // Row cursor at the bottom — fall through to the card cursor.
        }
        const next = Math.min(bucketed.tasks.length - 1, effectiveCardCursor + 1);
        setCardCursor(next);
        // Reset the row cursor so the next expanded card starts un-anchored.
        setFocusedKey(undefined);
        return;
      }
      if (key.upArrow || input === 'k') {
        if (rowCursorActive) {
          if (focusedIndex > 0) {
            setFocusedKey(flatKeys[focusedIndex - 1]);
            return;
          }
          // Row cursor at the top — fall through to the card cursor.
        }
        const next = Math.max(0, effectiveCardCursor - 1);
        setCardCursor(next);
        setFocusedKey(undefined);
        return;
      }
      if (key.return || input === ' ') {
        // Card-scope: toggle the focused card's expansion. Row-scope only kicks in when the
        // card is already expanded AND a row cursor is anchored.
        const rowCursorAnchored = focusedCardExpanded && flatKeys.length > 0 && focusedIndex >= 0;
        if (focusedCardId !== undefined && !rowCursorAnchored) {
          setExpandedTaskIds((prev) => {
            const next = new Set(prev);
            if (next.has(focusedCardId)) next.delete(focusedCardId);
            else next.add(focusedCardId);
            return next;
          });
          return;
        }
        // Row-scope: existing commit-message toggle behaviour.
        if (flatKeys.length === 0) return;
        const target = focusedIndex >= 0 ? focusedKey : flatKeys[flatKeys.length - 1];
        if (target === undefined) return;
        if (!isCommitMessageKey(target, bucketed)) {
          if (effectiveFocusedKey === undefined) setFocusedKey(target);
          return;
        }
        setExpandedKeys((prev) => {
          const next = new Set(prev);
          if (next.has(target)) next.delete(target);
          else next.add(target);
          return next;
        });
        if (effectiveFocusedKey === undefined) setFocusedKey(target);
      }
    },
    { isActive: inputActive }
  );

  if (bucketed.tasks.length === 0 && bucketed.orphanSignals.length === 0) {
    return (
      <Box paddingX={spacing.indent}>
        <Text dimColor>
          {glyphs.bullet} Tasks panel empty {glyphs.bullet} Run plan to generate tasks
        </Text>
      </Box>
    );
  }
  // First-run state — tasks exist but no harness signal has fired yet across the whole run.
  // The kinds bar is suppressed (it's already empty when no signals are present) and the
  // active-task block shows a `waiting for first attempt…` line below the spinner. Computed
  // here so `TaskBlock` can pick it up via a single prop.
  const noSignalsYet =
    bucketed.orphanSignals.length === 0 &&
    bucketed.tasks.every((t) => t.signals.length === 0 && t.evaluations.length === 0);
  const kinds = collectKinds(bucketed);
  const orphanSliceLen = Math.min(bucketed.orphanSignals.length, maxOrphanSignals);
  const orphanSliceStart = bucketed.orphanSignals.length - orphanSliceLen;
  return (
    <Box flexDirection="column" paddingX={spacing.indent}>
      <InlineKindsBar kinds={kinds} />
      <OrphanSignals
        signals={bucketed.orphanSignals}
        max={maxOrphanSignals}
        focusedKey={effectiveFocusedKey}
        expandedKeys={expandedKeys}
        sliceStart={orphanSliceStart}
      />
      {bucketed.tasks.map((task, idx) => {
        // Deliberate stylistic 8-char short-uuid fallback (NOT a width-driven clip) — keeps
        // the header readable when the launcher hasn't supplied a friendly name. The friendly
        // name path goes through `nameById` and renders verbatim; if a future design makes
        // the name itself overflow, wrap that path in a `<Box flexGrow>` + `wrap="truncate-end"`.
        const display = nameById?.get(task.id) ?? `${task.id.slice(0, 8)}${glyphs.clipEllipsis}`;
        const recovering = recoveringByTaskId?.get(task.id);
        const sliceLen = Math.min(task.signals.length, maxSignalsPerTask);
        const sliceStart = task.signals.length - sliceLen;
        // Read criteria synchronously from props (audit [05]). Empty arrays / missing keys
        // suppress the block entirely; non-empty arrays drive both the collapsed summary and
        // the per-criterion verdict alignment with evaluator dimensions.
        const criteriaBullets = taskCriteriaById?.get(task.id);
        const taskCriteria = criteriaBullets !== undefined && criteriaBullets.length > 0 ? criteriaBullets : undefined;
        // Match by id when a projection is supplied so the order of `sprintState.tasks`
        // doesn't have to mirror the bucketed order (projections are stored by `order`; bucketed
        // tasks track the runtime sequence).
        const taskProjection = sprintState?.tasks.find((t: TaskProjection) => t.id === task.id);
        const isActive = idx === activeTaskIdx;
        return (
          <TaskBlock
            key={task.id}
            task={task}
            running={running}
            display={display}
            maxSignals={maxSignalsPerTask}
            maxSubSteps={maxSubStepsPerTask}
            maxEvaluations={maxEvaluationsPerTask}
            focusedKey={effectiveFocusedKey}
            expandedKeys={expandedKeys}
            scopeId={task.id}
            sliceStart={sliceStart}
            criteriaExpanded={criteriaExpandedIds.has(task.id)}
            showEvaluatorFailureUI={showEvaluatorFailureUI}
            isActive={isActive}
            firstRun={noSignalsYet}
            cardExpanded={isCardExpanded(task.id)}
            cardFocused={idx === effectiveCardCursor}
            nowMs={effectiveNowMs}
            {...(recovering !== undefined ? { recovering } : {})}
            {...(taskCriteria !== undefined ? { taskCriteria } : {})}
            {...(taskProjection !== undefined ? { taskProjection } : {})}
          />
        );
      })}
    </Box>
  );
};
