/** Per-signal row renderers for the Tasks panel. */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { CommitMessageSignal, ContextCompactedSignal, HarnessSignal } from '@src/domain/signal.ts';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import { glyphFor, glyphs, inkColors, type SignalKind, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useNoColor } from '@src/application/ui/tui/runtime/use-no-color.ts';
import { fmtIsoTime } from '@src/application/ui/tui/theme/duration.ts';
import {
  collapseWhitespace,
  formatCompactionDetail,
  KIND_COL_WIDTH,
  padLabel,
  TIME_COL_WIDTH,
} from '@src/application/ui/tui/components/tasks-panel-internals/format.ts';

/**
 * Signal-label vocabulary. Labels are full words (not 4-letter codes) so the dashboard reads at a glance without a
 * legend.
 * @public
 */
export const SIGNAL_LABEL_COLOR: Readonly<Record<SignalKind, string>> = {
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
  reproduce: inkColors.info,
  judge: inkColors.highlight,
};

/** Colour for a free-form label (help-overlay reference rows); `undefined` when it isn't a signal kind. */
export const signalLabelColor = (label: string): string | undefined =>
  Object.hasOwn(SIGNAL_LABEL_COLOR, label) ? SIGNAL_LABEL_COLOR[label as SignalKind] : undefined;

interface SignalRow {
  readonly label: SignalKind;
  readonly text: string;
  readonly bold?: boolean;
}

/** One renderer per signal kind. */
type SignalRowBuilders = {
  readonly [K in HarnessSignal['type']]: (sig: Extract<HarnessSignal, { readonly type: K }>) => SignalRow | undefined;
};

const SIGNAL_ROW_BUILDERS: SignalRowBuilders = {
  change: (sig) => ({ label: 'change', text: sig.text }),
  learning: (sig) => ({ label: 'learning', text: sig.text }),
  decision: (sig) => ({ label: 'decision', text: sig.text, bold: true }),
  // The subject is the source of truth — the harness owns the trailer-appending logic and re-emits the signal with
  // the resolved body.
  'commit-message': (sig) => ({ label: 'commit', text: sig.subject }),
  note: (sig) => ({ label: 'note', text: sig.text }),
  'task-complete': () => ({ label: 'done', text: 'task complete' }),
  'task-verified': (sig) => ({ label: 'verified', text: collapseWhitespace(sig.output) }),
  'task-blocked': (sig) => ({ label: 'blocked', text: sig.reason }),
  'setup-script': (sig) => ({ label: 'script', text: `${sig.type}: ${sig.command}` }),
  'verify-script': (sig) => ({ label: 'script', text: `${sig.type}: ${sig.command}` }),
  'verify-gates': (sig) => ({
    label: 'script',
    text: `verify-gates: ${String(sig.gates.length)} module${sig.gates.length === 1 ? '' : 's'}`,
  }),
  'agents-md-proposal': (sig) => ({
    label: 'proposal',
    text: `context file proposal (${String(sig.content.length)} chars)`,
  }),
  'setup-skill-proposal': (sig) => ({
    label: 'proposal',
    text: `setup-skill proposal (${String(sig.content.length)} chars)`,
  }),
  'verify-skill-proposal': (sig) => ({
    label: 'proposal',
    text: `verify-skill proposal (${String(sig.content.length)} chars)`,
  }),
  'skill-suggestions': (sig) => ({ label: 'skills', text: sig.names.length > 0 ? sig.names.join(', ') : '(none)' }),
  reproduction: (sig) => ({
    label: 'reproduce',
    text: sig.reproduced === false ? `not reproduced — ${sig.reason ?? 'no reason given'}` : sig.testPath,
  }),
  'candidate-selection': (sig) => ({
    label: 'judge',
    text: `${sig.winner === 0 ? 'tie' : `winner: candidate ${String(sig.winner)}`} — ${sig.rationale}`,
  }),
  evaluation: () => undefined,
  'context-compacted': () => undefined,
  // Whole-artifact payloads produced by the refine / plan / ideate / create-PR flows. They are
  // consumed by those flows' own views, never streamed into a task card, so they have no row here.
  'refined-ticket': () => undefined,
  'task-plan': () => undefined,
  'ideated-tickets': () => undefined,
  'pr-content': () => undefined,
};

export const rowForSignal = (sig: HarnessSignal): SignalRow | undefined => {
  // The table is keyed by the discriminant, so the entry for `sig.type` is by construction the
  // one that narrows to `sig` — a relationship the indexed access type can't express on its own.
  const build = SIGNAL_ROW_BUILDERS[sig.type] as (s: HarnessSignal) => SignalRow | undefined;
  return build(sig);
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
  const color = SIGNAL_LABEL_COLOR[row.label];
  // Shape backup — when NO_COLOR is in effect the colour swatch on the label disappears, so prefix the label with a
  // per-kind glyph (`+` change, `~` learning, `■` commit, …).
  const shapeGlyph = noColor ? glyphFor(row.label) : '';
  // Layout: fixed timestamp + fixed label column + flex-grow body that ellides on the terminal's actual width via
  // Ink's `wrap="truncate-end"`.
  return (
    <Box>
      <Box flexShrink={0}>
        <Box flexShrink={0}>
          <Text color={focused ? inkColors.highlight : inkColors.muted} bold={focused}>
            {focused ? glyphs.selectMarker : ' '}{' '}
          </Text>
        </Box>
      </Box>
      <Box width={TIME_COL_WIDTH} flexShrink={0}>
        <Text dimColor>{fmtIsoTime(String(signal.timestamp))}</Text>
      </Box>
      <Box width={KIND_COL_WIDTH} flexShrink={0}>
        <Text color={color} bold>
          {'  '}
          {shapeGlyph !== '' ? `${shapeGlyph} ${padLabel(row.label)}` : `  ${padLabel(row.label)}`}
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text bold={row.bold ?? false} wrap="truncate-end">
          {collapseWhitespace(row.text)}
        </Text>
      </Box>
    </Box>
  );
};

/**
 * Collapsible variant for `commit-message` signals. Default state is collapsed: only the commit subject line shows,
 * identical in layout to {@link SignalLine}.
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
  const color = SIGNAL_LABEL_COLOR.commit;
  // Lines below the subject — body paragraphs — derived from `signal.body`.
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
  // The focus caret above deliberately stays on `selectMarker` (`›`) rather than `actionCursor` (`▸`).
  const disclosure = canExpand ? (expanded ? glyphs.disclosureExpanded : glyphs.disclosureCollapsed) : ' ';
  return (
    <Box flexDirection="column">
      <Box>
        <Box flexShrink={0}>
          <Text color={focused ? inkColors.highlight : inkColors.muted} bold={focused}>
            {focused ? glyphs.selectMarker : ' '}{' '}
          </Text>
        </Box>
        <Box width={TIME_COL_WIDTH} flexShrink={0}>
          <Text dimColor>{fmtIsoTime(String(signal.timestamp))}</Text>
        </Box>
        <Box width={KIND_COL_WIDTH} flexShrink={0}>
          <Text color={color} bold>
            {'  '}
            {disclosure} {padLabel('commit')}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text wrap="truncate-end">{collapseWhitespace(headline)}</Text>
        </Box>
      </Box>
      {expanded && canExpand && (
        // Indent under the signal label column so the body visually nests beneath its subject.
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

/** Dedented lifecycle-boundary marker for `context-compacted` signals. */
const CompactionMarker = ({ signal }: { readonly signal: ContextCompactedSignal }): React.JSX.Element => {
  const detail = formatCompactionDetail(signal);
  return (
    <Box marginLeft={-spacing.indent}>
      <Box width={TIME_COL_WIDTH} flexShrink={0}>
        <Text dimColor>{fmtIsoTime(String(signal.timestamp))}</Text>
      </Box>
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
 * Dispatch from a signal to its renderer: `context-compacted` → dedented {@link CompactionMarker}; `commit-message` →
 * collapsible {@link CommitSignalLine}.
 */
const StreamSignalRowImpl = ({
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

/** Memoized (default shallow compare — no `now`-style prop here). */
export const StreamSignalRow = React.memo(StreamSignalRowImpl);

/**
 * One-row inline kinds bar — colored signal-kind labels for kinds that have actually appeared in the bucketed signals
 * so far.
 */
export const InlineKindsBar = ({ kinds }: { readonly kinds: readonly SignalKind[] }): React.JSX.Element | null => {
  if (kinds.length === 0) return null;
  return (
    <Box marginBottom={spacing.section}>
      <Text dimColor>{glyphs.bullet} kinds:</Text>
      {kinds.map((kind) => (
        <Text key={kind} color={SIGNAL_LABEL_COLOR[kind]} bold>
          {'  '}
          {kind}
        </Text>
      ))}
    </Box>
  );
};

export const collectKinds = (bucketed: BucketedExecution): readonly SignalKind[] => {
  const seen = new Set<SignalKind>();
  const order: SignalKind[] = [];
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
