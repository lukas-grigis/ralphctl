/**
 * Per-signal row renderers for the Tasks panel. Each `HarnessSignal` maps to one of three row
 * shapes:
 *
 *   - `context-compacted` → {@link CompactionMarker} (dedented lifecycle boundary)
 *   - `commit-message`    → {@link CommitSignalLine} (collapsible body)
 *   - everything else     → {@link SignalLine} (default fixed-column row)
 *
 * {@link StreamSignalRow} dispatches between the three.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { CommitMessageSignal, ContextCompactedSignal, HarnessSignal } from '@src/domain/signal.ts';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import { glyphFor, glyphs, inkColors, type SignalKind, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useNoColor } from '@src/application/ui/tui/runtime/use-no-color.ts';
import { fmtIsoTime } from '@src/application/ui/tui/theme/duration.ts';
import {
  COLLAPSED_DISCLOSURE,
  collapseWhitespace,
  EXPANDED_DISCLOSURE,
  FOCUS_CURSOR,
  formatCompactionDetail,
  padLabel,
} from '@src/application/ui/tui/components/tasks-panel-internals/format.ts';

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

export const rowForSignal = (sig: HarnessSignal): SignalRow | undefined => {
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
    case 'task-complete':
      return { label: 'done', text: 'task complete' };
    case 'task-verified':
      return { label: 'verified', text: collapseWhitespace(sig.output) };
    case 'task-blocked':
      return { label: 'blocked', text: sig.reason };
    case 'setup-script':
    case 'verify-script':
      return { label: 'script', text: `${sig.type}: ${sig.command}` };
    case 'verify-gates':
      return {
        label: 'script',
        text: `verify-gates: ${String(sig.gates.length)} module${sig.gates.length === 1 ? '' : 's'}`,
      };
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
  // empty string for kinds whose label already self-discriminates (`done`, `script`, …).
  const shapeGlyph = noColor ? glyphFor(row.label as SignalKind) : '';
  // Layout: fixed timestamp + fixed label column + flex-grow body that ellides on the
  // terminal's actual width via Ink's `wrap="truncate-end"`. The body Box must have
  // `minWidth={0}` so Ink's flex algorithm allows it to shrink below its intrinsic width
  // — without that, long text in a `flexGrow` ancestor that lacks an explicit pixel width
  // (e.g. the main column in the wide layout: `flexGrow={1} flexBasis={0} minWidth={0}`)
  // does not reach the body Box with a bounded constraint, and the text overflows instead
  // of ellipsing. Adding `minWidth={0}` on the body Box opts it into the bounded layout.
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
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
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
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
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
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
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
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
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
 * is rendered by the dedicated `<EvaluationLine>` component).
 */
export const StreamSignalRow = ({
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
export const InlineKindsBar = ({ kinds }: { readonly kinds: readonly string[] }): React.JSX.Element | null => {
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

export const collectKinds = (bucketed: BucketedExecution): readonly string[] => {
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
