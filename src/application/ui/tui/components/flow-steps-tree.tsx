/**
 * Step tree — renders a `StepView` forest (`flow-progress.ts`) as indented rows. Depth is drawn
 * with `spacing.indent` per level plus the existing phase glyphs; there are no connector glyphs.
 *
 * Each row is ONE truncating `<Text>` so a long label can never wrap onto a second line, and a
 * failed row's error message sits on its own row underneath it. The list is windowed with
 * `computeListWindow` + `OverflowRow`, anchored on the failed row once the run settled failed and
 * otherwise on the running row. Read-only: no cursor, no keys.
 *
 * `StepRowLine` / `StepRowsWindow` are shared with the per-task tree in the Tasks panel.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { fmtDuration } from '@src/application/ui/tui/theme/duration.ts';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { computeListWindow, OverflowRow } from '@src/application/ui/tui/components/windowed-list.tsx';
import {
  flattenStepRows,
  type RoundVerdict,
  type StepStatus,
  type StepView,
} from '@src/application/ui/tui/runtime/flow-progress.ts';

/** A view with no `leafCount` is a plain leaf; every composite, loop iteration and fold sets it. */
const isLeafView = (view: StepView): boolean =>
  view.leafCount === undefined && view.iteration === undefined && view.progress === undefined;

interface Mark {
  readonly glyph?: string;
  readonly color: string;
  readonly spinner?: true;
}

/** Glyph + colour per status. A running leaf spins; a running composite reads as the active phase. */
export const stepMark = (status: StepStatus, leaf: boolean): Mark => {
  switch (status) {
    case 'completed':
      return { glyph: glyphs.phaseDone, color: inkColors.success };
    case 'running':
      return leaf ? { color: inkColors.info, spinner: true } : { glyph: glyphs.phaseActive, color: inkColors.primary };
    case 'waiting':
    case 'aborted':
      return { glyph: glyphs.warningGlyph, color: inkColors.warning };
    case 'failed':
      return { glyph: glyphs.cross, color: inkColors.error };
    case 'skipped':
      return { glyph: glyphs.phaseDisabled, color: inkColors.muted };
    case 'pending':
      return { glyph: glyphs.phasePending, color: inkColors.muted };
  }
};

const StatusMark = ({
  status,
  leaf,
  spin,
}: {
  readonly status: StepStatus;
  readonly leaf: boolean;
  readonly spin: boolean;
}): React.JSX.Element => {
  const mark = stepMark(status, leaf);
  if (mark.spinner === true) return <Spinner active={spin} color={mark.color} />;
  return (
    <Text color={mark.color} bold>
      {mark.glyph}
    </Text>
  );
};

const VerdictChip = ({ verdict }: { readonly verdict: RoundVerdict }): React.JSX.Element => {
  if (verdict.status === 'passed') return <Text color={inkColors.success}>{glyphs.check} passed</Text>;
  if (verdict.status === 'malformed') return <Text>{glyphs.unknownGlyph} malformed</Text>;
  const dims = verdict.dimensions.length > 0 ? verdict.dimensions.join(', ') : 'failed';
  return (
    <>
      <Text color={inkColors.error}>
        {glyphs.cross} {dims}
      </Text>
      {verdict.headline !== undefined && (
        <Text dimColor>
          {' '}
          {glyphs.emDash} {verdict.headline}
        </Text>
      )}
    </>
  );
};

const SEP = ` ${glyphs.bullet} `;

const rowLabel = (view: StepView): string => {
  const { iteration, progress } = view;
  if (iteration !== undefined) {
    const live = view.status === 'running' || view.status === 'waiting' || view.status === 'failed';
    const n =
      live && iteration.max !== undefined ? `${String(iteration.n)}/${String(iteration.max)}` : String(iteration.n);
    return `${view.label} ${n}`;
  }
  if (progress !== undefined) return `${view.label} ${String(progress.done)}/${String(progress.total)}`;
  return view.label;
};

/** Plain-text metadata after the label: step count, duration, state word. */
const metaText = (view: StepView): string => {
  const parts: string[] = [];
  const collapsed = view.children.length === 0 && view.inline === undefined;
  if (view.status === 'completed' && collapsed && view.iteration === undefined && (view.leafCount ?? 0) > 1) {
    parts.push(`${String(view.leafCount)} steps`);
  }
  if (view.durationMs !== undefined) parts.push(fmtDuration(view.durationMs));
  if (view.status === 'skipped') parts.push('skipped');
  if (view.status === 'aborted') parts.push('aborted');
  return parts.map((p) => `${SEP}${p}`).join('');
};

const InlineLeaves = ({
  leaves,
  spin,
}: {
  readonly leaves: readonly StepView[];
  readonly spin: boolean;
}): React.JSX.Element => (
  <>
    {leaves.map((leaf) => (
      <React.Fragment key={leaf.key}>
        <Text dimColor>{SEP}</Text>
        <StatusMark status={leaf.status} leaf spin={spin} />
        <Text dimColor={leaf.status === 'pending'}> {leaf.label}</Text>
      </React.Fragment>
    ))}
  </>
);

export interface StepRowLineProps {
  readonly view: StepView;
  /** Nesting level below the tree root — `spacing.indent` columns each. */
  readonly level: number;
  /** Whether a running leaf's spinner animates (false once the session settled). */
  readonly spin: boolean;
}

/** One step row: mark, label, metadata, verdict chip, inline round leaves — a single truncating line. */
export const StepRowLine = ({ view, level, spin }: StepRowLineProps): React.JSX.Element => {
  const pad = level * spacing.indent;
  if (view.earlier !== undefined) {
    return (
      <Box paddingLeft={pad}>
        <Text dimColor wrap="truncate-end">
          {glyphs.moreAbove} {view.label}
        </Text>
      </Box>
    );
  }
  const leaf = isLeafView(view);
  const active = view.status === 'running' || view.status === 'waiting';
  return (
    <Box paddingLeft={pad}>
      <Text wrap="truncate-end">
        <StatusMark status={view.status} leaf={leaf} spin={spin} />
        <Text dimColor={view.status === 'pending'} bold={active && !leaf}>
          {' '}
          {rowLabel(view)}
        </Text>
        <Text dimColor>{metaText(view)}</Text>
        {view.verdict !== undefined && (
          <>
            <Text dimColor>{SEP}</Text>
            <VerdictChip verdict={view.verdict} />
          </>
        )}
        {view.inline !== undefined && <InlineLeaves leaves={view.inline} spin={spin} />}
        {view.tail !== undefined && active && <Text color={inkColors.info}>{`${SEP}${view.tail}`}</Text>}
        {view.status === 'waiting' && <Text color={inkColors.warning}>{`${SEP}waiting on you`}</Text>}
      </Text>
    </Box>
  );
};

/** One displayable line: a step, or a failed step's message. */
export interface StepDisplayRow {
  readonly key: string;
  readonly view: StepView;
  readonly level: number;
  readonly message?: string;
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Flatten a forest into windowable rows; levels are relative to the shallowest row. */
export const stepDisplayRows = (views: readonly StepView[]): readonly StepDisplayRow[] => {
  const flat = flattenStepRows(views);
  const base = flat.reduce((min, v) => Math.min(min, v.depth), Number.POSITIVE_INFINITY);
  return flat.flatMap((view): StepDisplayRow[] => {
    const level = Math.max(0, view.depth - (Number.isFinite(base) ? base : 0));
    const row: StepDisplayRow = { key: view.key, view, level };
    const failed = view.status === 'failed' || view.status === 'aborted';
    return failed && view.errorMessage !== undefined && collapse(view.errorMessage).length > 0
      ? [row, { key: `${view.key}:message`, view, level: level + 1, message: collapse(view.errorMessage) }]
      : [row];
  });
};

const isActiveStatus = (s: StepStatus): boolean => s === 'running' || s === 'waiting';

/**
 * Index to keep visible: the deepest failed row once settled-failed, otherwise the deepest running
 * row (rows are parents-first, so the last match is the leaf-most one).
 */
export const anchorIndexOf = (rows: readonly StepDisplayRow[], settled: boolean): number => {
  const lastStep = (pred: (s: StepStatus) => boolean): number =>
    rows.reduce((found, r, i) => (r.message === undefined && pred(r.view.status) ? i : found), -1);
  const failed = (s: StepStatus): boolean => s === 'failed' || s === 'aborted';
  if (settled) {
    const at = lastStep(failed);
    return at >= 0 ? at : rows.length - 1;
  }
  const active = lastStep(isActiveStatus);
  if (active >= 0) return active;
  const at = lastStep(failed);
  if (at >= 0) return at;
  const firstPending = rows.findIndex((r) => r.view.status === 'pending');
  return Math.max(0, firstPending - 1);
};

/** Window whose overflow cues are paid for out of `maxRows`, so the whole block never exceeds it. */
export const windowRows = (total: number, anchor: number, maxRows: number): ReturnType<typeof computeListWindow> => {
  const first = computeListWindow(total, anchor, maxRows);
  const cues = (first.hiddenAbove > 0 ? 1 : 0) + (first.hiddenBelow > 0 ? 1 : 0);
  if (cues === 0) return first;
  const second = computeListWindow(total, anchor, Math.max(1, maxRows - cues));
  const cues2 = (second.hiddenAbove > 0 ? 1 : 0) + (second.hiddenBelow > 0 ? 1 : 0);
  return cues2 === cues ? second : computeListWindow(total, anchor, Math.max(1, maxRows - cues2));
};

export interface StepRowsWindowProps {
  readonly rows: readonly StepDisplayRow[];
  readonly maxRows: number;
  /** The run is over — anchor on a failure instead of the running row. */
  readonly settled: boolean;
  readonly spin: boolean;
}

export const StepRowsWindow = ({ rows, maxRows, settled, spin }: StepRowsWindowProps): React.JSX.Element | null => {
  if (rows.length === 0) return null;
  const win = windowRows(rows.length, anchorIndexOf(rows, settled), maxRows);
  return (
    <Box flexDirection="column">
      <OverflowRow direction="above" count={win.hiddenAbove} />
      {rows.slice(win.start, win.end).map((row) =>
        row.message !== undefined ? (
          <Box key={row.key} paddingLeft={spacing.indent + row.level * spacing.indent}>
            <Text color={inkColors.error} wrap="truncate-end">
              {glyphs.emDash} {row.message}
            </Text>
          </Box>
        ) : (
          <Box key={row.key} paddingLeft={spacing.indent}>
            <StepRowLine view={row.view} level={row.level} spin={spin} />
          </Box>
        )
      )}
      <OverflowRow direction="below" count={win.hiddenBelow} />
    </Box>
  );
};

export interface FlowStepsTreeProps {
  readonly spine: readonly StepView[];
  readonly maxRows: number;
  readonly settled: boolean;
  readonly running: boolean;
  /** Column budget; rows truncate with `…` instead of wrapping. */
  readonly width?: number;
}

const FlowStepsTreeImpl = ({ spine, maxRows, settled, running, width }: FlowStepsTreeProps): React.JSX.Element => {
  const rows = stepDisplayRows(spine);
  return (
    <Box flexDirection="column" {...(width !== undefined ? { width } : {})}>
      <StepRowsWindow rows={rows} maxRows={maxRows} settled={settled} spin={running} />
    </Box>
  );
};

// The projection keeps `spine` referentially stable between changes, so the 1 Hz clock never re-renders the tree.
export const FlowStepsTree = React.memo(FlowStepsTreeImpl);
