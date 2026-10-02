/** Live step trace — renders the planned flow as a vertical list of rows with a glyph per status. */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { Trace, TraceEntry } from '@src/application/chain/trace.ts';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { fmtDuration } from '@src/application/ui/tui/theme/duration.ts';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { computeListWindow } from '@src/application/ui/tui/components/windowed-list.tsx';
import { clipWithEllipsis } from '@src/application/ui/tui/components/format.ts';

export interface StepTraceProps {
  readonly trace: Trace;
  readonly running: boolean;
  readonly filter?: (name: string) => boolean;
  readonly maxRows?: number;
  /** When the chain is running and the last entry is settled, append a synthetic "in flight" row. */
  readonly inFlightLabel?: string;
  /** Planned leaf names in execution order. */
  readonly plan?: readonly string[];
  /** Display label for plan entries that have not yet executed — keyed by element name. */
  readonly labelByName?: ReadonlyMap<string, string>;
  /**
   * When `true`, only the per-row status glyph renders — leaf name, duration, trailing label, and error message are
   * all suppressed.
   */
  readonly compact?: boolean;
  /**
   * When `true`, each row renders `glyph + name` only — duration, trailing status label, and error message are
   * suppressed.
   */
  readonly suppressMeta?: boolean;
  /** Optional rail-column width (in characters). */
  readonly railWidth?: number;
}

type RowStatus = TraceEntry['status'] | 'pending' | 'running';

interface MergedRow {
  readonly name: string;
  /**
   * Optional display label sourced from `Element.label` / `TraceEntry.label`; renderer prefers this over `name`.
   */
  readonly label?: string;
  readonly status: RowStatus;
  readonly durationMs?: number;
  readonly errorMessage?: string;
}

/** Per-row glyph instruction. */
type GlyphInstruction =
  | { readonly kind: 'static'; readonly glyph: string; readonly color: string }
  | { readonly kind: 'spinner'; readonly color: string };

const glyphFor = (status: RowStatus): GlyphInstruction => {
  switch (status) {
    case 'completed':
      return { kind: 'static', glyph: glyphs.phaseDone, color: inkColors.success };
    case 'failed':
      return { kind: 'static', glyph: glyphs.cross, color: inkColors.error };
    case 'aborted':
      return { kind: 'static', glyph: glyphs.warningGlyph, color: inkColors.warning };
    case 'skipped':
      return { kind: 'static', glyph: glyphs.phaseDisabled, color: inkColors.muted };
    case 'running':
      return { kind: 'spinner', color: inkColors.info };
    case 'pending':
      return { kind: 'static', glyph: glyphs.phasePending, color: inkColors.muted };
  }
};

/** Short label appended next to non-success terminal statuses. */
const trailingLabelFor = (status: RowStatus): string | undefined => {
  switch (status) {
    case 'skipped':
      return 'skipped';
    case 'aborted':
      return 'aborted';
    case 'pending':
      return 'pending';
    default:
      return undefined;
  }
};

/** Merge plan + trace into a single ordered row list. */
const mergePlanWithTrace = (
  plan: readonly string[],
  trace: Trace,
  running: boolean,
  labelByName?: ReadonlyMap<string, string>
): readonly MergedRow[] => {
  const lastByName = new Map<string, TraceEntry>();
  for (const entry of trace) lastByName.set(entry.elementName, entry);
  let promotedRunning = !running;
  return plan.map((name) => {
    const entry = lastByName.get(name);
    if (entry !== undefined) {
      return {
        name,
        // TraceEntry-supplied label wins over the static lookup so a leaf that mutates its label between construction
        // and execution is still reflected.
        ...(entry.label !== undefined
          ? { label: entry.label }
          : labelByName?.get(name) !== undefined
            ? { label: labelByName.get(name) as string }
            : {}),
        status: entry.status,
        durationMs: entry.durationMs,
        ...(entry.error !== undefined ? { errorMessage: entry.error.message } : {}),
      };
    }
    const planLabel = labelByName?.get(name);
    const baseLabel = planLabel !== undefined ? { label: planLabel } : {};
    if (!promotedRunning) {
      promotedRunning = true;
      return { name, status: 'running', ...baseLabel };
    }
    return { name, status: 'pending', ...baseLabel };
  });
};

const traceToRows = (trace: Trace): readonly MergedRow[] =>
  trace.map((entry) => ({
    name: entry.elementName,
    ...(entry.label !== undefined ? { label: entry.label } : {}),
    status: entry.status,
    durationMs: entry.durationMs,
    ...(entry.error !== undefined ? { errorMessage: entry.error.message } : {}),
  }));

interface StepTraceRowProps {
  readonly row: MergedRow;
  readonly running: boolean;
  readonly compact: boolean;
  readonly suppressMeta: boolean;
  readonly textBudget: number | undefined;
}

/**
 * One row of the trace list: status glyph/spinner, optional name + duration + trailing label + error tail.
 */
const StepTraceRow = ({ row, running, compact, suppressMeta, textBudget }: StepTraceRowProps): React.JSX.Element => {
  const instruction = glyphFor(row.status);
  const trailing = trailingLabelFor(row.status);
  const dimRow = row.status === 'pending';
  const displayName = row.label ?? row.name;
  const shownName = textBudget !== undefined ? clipWithEllipsis(displayName, textBudget) : displayName;
  return (
    <Box paddingX={spacing.indent}>
      {instruction.kind === 'spinner' ? (
        <Spinner active={running} color={instruction.color} />
      ) : (
        <Text color={instruction.color} bold>
          {instruction.glyph}
        </Text>
      )}
      {!compact && (
        <>
          <Text dimColor={dimRow}> {shownName}</Text>
          {!suppressMeta && row.durationMs !== undefined && (
            <Text dimColor>
              {' '}
              {glyphs.bullet} {fmtDuration(row.durationMs)}
            </Text>
          )}
          {!suppressMeta && trailing !== undefined && (
            <Text color={instruction.color}>
              {'  '}
              {glyphs.emDash} {trailing}
            </Text>
          )}
          {!suppressMeta && row.errorMessage !== undefined && (
            <Text color={inkColors.error}>
              {'  '}
              {glyphs.emDash} {row.errorMessage}
            </Text>
          )}
        </>
      )}
    </Box>
  );
};

export const StepTrace = ({
  trace,
  running,
  filter,
  maxRows = 12,
  inFlightLabel,
  plan,
  labelByName,
  compact = false,
  suppressMeta = false,
  railWidth,
}: StepTraceProps): React.JSX.Element => {
  // Memoize the plan/trace merge — `mergePlanWithTrace` walks the entire trace to build a lookup Map on every call.
  const traceLastEntry = trace[trace.length - 1];
  const merged = useMemo(
    () => (plan !== undefined ? mergePlanWithTrace(plan, trace, running, labelByName) : traceToRows(trace)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- in-place ring-buffer mutation; see comment above
    [plan, labelByName, trace, trace.length, traceLastEntry, running]
  );
  const filtered = useMemo(
    () => (filter !== undefined ? merged.filter((r) => filter(r.name)) : merged),
    [merged, filter]
  );

  // Anchor on the first running row when we have one; otherwise keep the tail so a long
  // post-mortem trace still ends at the failing step rather than the head.
  const runningIdx = filtered.findIndex((r) => r.status === 'running');
  const win = runningIdx >= 0 ? computeListWindow(filtered.length, runningIdx, maxRows) : undefined;
  const rows = win !== undefined ? filtered.slice(win.start, win.end) : filtered.slice(-maxRows);

  // Text-budget calculation: subtract 4 from the rail width to reserve room for the leading glyph (1), its trailing
  // space (1), the column's `paddingX={spacing.indent}` left edge (2).
  const textBudget = railWidth !== undefined ? Math.max(1, railWidth - 4) : undefined;

  return (
    <Box flexDirection="column">
      {rows.map((row, i) => (
        <StepTraceRow
          key={`${row.name}-${String(i)}`}
          row={row}
          running={running}
          compact={compact}
          suppressMeta={suppressMeta}
          textBudget={textBudget}
        />
      ))}
      {/* When no plan is supplied we keep the legacy "in flight" cursor at the tail. With a
          plan, the merged list already has a `running` row, so the synthetic cursor is omitted
          to avoid double-rendering. */}
      {plan === undefined && running && inFlightLabel !== undefined && (
        <Box paddingX={spacing.indent}>
          <Spinner active={running} color={inkColors.info} />
          <Text dimColor> {inFlightLabel}</Text>
        </Box>
      )}
    </Box>
  );
};
