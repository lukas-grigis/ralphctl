/**
 * Live step trace — renders the planned flow as a vertical list of rows with a glyph per status.
 * Combines two inputs:
 *
 *  - `plan` (optional): the *full* list of expected leaves in execution order. Captured at
 *    chain-construction time via `flattenLeaves(element)`. Each plan entry renders even before
 *    it runs — pending steps show a dim hollow glyph (`◇`) so the operator sees what's ahead.
 *  - `trace`: the live record of what has executed; status drives the glyph for plan entries
 *    that match by name (last terminal entry wins, so a re-run leaf shows its newest state).
 *
 * Without `plan`, falls back to the legacy mode of rendering trace entries only.
 *
 * Filtering: applies before the plan/trace merge; pass the same predicate the execute view uses
 * to exclude per-task substeps (the Tasks panel renders those).
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { Trace, TraceEntry } from '@src/application/chain/trace.ts';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { fmtDuration } from '@src/application/ui/tui/theme/duration.ts';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';

export interface StepTraceProps {
  readonly trace: Trace;
  readonly running: boolean;
  readonly filter?: (name: string) => boolean;
  readonly maxRows?: number;
  /** When the chain is running and the last entry is settled, append a synthetic "in flight" row. */
  readonly inFlightLabel?: string;
  /**
   * Planned leaf names in execution order. Renders pending rows for steps not yet in the trace;
   * the in-flight cursor (first unmatched plan entry while running) gets a spinner.
   */
  readonly plan?: readonly string[];
}

type RowStatus = TraceEntry['status'] | 'pending' | 'running';

interface MergedRow {
  readonly name: string;
  readonly status: RowStatus;
  readonly durationMs?: number;
  readonly errorMessage?: string;
}

/**
 * Per-row glyph instruction. Either a static glyph (rendered inline by the caller's `<Text>`) or
 * a `spinner` sentinel — in which case the caller renders a `<Spinner />` leaf, which owns its
 * own 90 ms re-render scope. Returning the sentinel (instead of calling `spinnerGlyph(frame)`
 * here) is what allows StepTrace to drop the `useSpinnerFrame` call at the top of the component:
 * the spinner re-render no longer ticks the whole row list, only the spinner node itself.
 */
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

/**
 * Short label appended next to non-success terminal statuses. Without this, a `skipped` entry
 * shows only a dim glyph, which reads as "still pending / frozen" rather than "this step was
 * cancelled because an earlier step failed". `failed` and `completed` are obvious from glyph +
 * error message and don't need extra text.
 */
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

/**
 * Merge plan + trace into a single ordered row list. Plan entries are matched against trace
 * entries by name; the *last* trace entry wins (so a re-running leaf reflects its newest
 * state). Unmatched plan entries stay `pending`. While the chain is running, the first
 * `pending` row promotes to `running` so the operator sees the in-flight cursor.
 */
const mergePlanWithTrace = (plan: readonly string[], trace: Trace, running: boolean): readonly MergedRow[] => {
  const lastByName = new Map<string, TraceEntry>();
  for (const entry of trace) lastByName.set(entry.elementName, entry);
  let promotedRunning = !running;
  return plan.map((name) => {
    const entry = lastByName.get(name);
    if (entry !== undefined) {
      return {
        name,
        status: entry.status,
        durationMs: entry.durationMs,
        ...(entry.error !== undefined ? { errorMessage: entry.error.message } : {}),
      };
    }
    if (!promotedRunning) {
      promotedRunning = true;
      return { name, status: 'running' };
    }
    return { name, status: 'pending' };
  });
};

const traceToRows = (trace: Trace): readonly MergedRow[] =>
  trace.map((entry) => ({
    name: entry.elementName,
    status: entry.status,
    durationMs: entry.durationMs,
    ...(entry.error !== undefined ? { errorMessage: entry.error.message } : {}),
  }));

export const StepTrace = ({
  trace,
  running,
  filter,
  maxRows = 12,
  inFlightLabel,
  plan,
}: StepTraceProps): React.JSX.Element => {
  // Memoize the plan/trace merge — `mergePlanWithTrace` walks the entire trace to build a
  // lookup Map on every call. For long running sessions (5k+ trace entries) re-allocating that
  // every render adds avoidable GC pressure even though the cost is fast in absolute terms.
  //
  // The runner mutates `trace` in place via push (+ ring eviction at the cap), so the array
  // reference is stable across pushes. Including `trace.length` AND the last-entry identity in
  // the dep list keeps the memo correct: length flips while the buffer fills; once we hit the
  // ring cap, length sticks but the last entry's object identity still changes per push.
  const traceLastEntry = trace[trace.length - 1];
  const merged = useMemo(
    () => (plan !== undefined ? mergePlanWithTrace(plan, trace, running) : traceToRows(trace)),
    [plan, trace, trace.length, traceLastEntry, running]
  );
  const filtered = useMemo(
    () => (filter !== undefined ? merged.filter((r) => filter(r.name)) : merged),
    [merged, filter]
  );

  // Anchor on the first running row when we have one; otherwise keep the tail so a long
  // post-mortem trace still ends at the failing step rather than the head.
  const runningIdx = filtered.findIndex((r) => r.status === 'running');
  const rows =
    runningIdx >= 0
      ? filtered.slice(Math.max(0, runningIdx - Math.floor(maxRows / 2))).slice(0, maxRows)
      : filtered.slice(-maxRows);

  return (
    <Box flexDirection="column">
      {rows.map((row, i) => {
        const instruction = glyphFor(row.status);
        const trailing = trailingLabelFor(row.status);
        const dimRow = row.status === 'pending';
        return (
          <Box key={`${row.name}-${String(i)}`} paddingX={spacing.indent}>
            {instruction.kind === 'spinner' ? (
              <Spinner active={running} color={instruction.color} />
            ) : (
              <Text color={instruction.color} bold>
                {instruction.glyph}
              </Text>
            )}
            <Text dimColor={dimRow}> {row.name}</Text>
            {row.durationMs !== undefined && (
              <Text dimColor>
                {' '}
                {glyphs.bullet} {fmtDuration(row.durationMs)}
              </Text>
            )}
            {trailing !== undefined && (
              <Text color={instruction.color}>
                {'  '}
                {glyphs.emDash} {trailing}
              </Text>
            )}
            {row.errorMessage !== undefined && (
              <Text color={inkColors.error}>
                {'  '}
                {glyphs.emDash} {row.errorMessage}
              </Text>
            )}
          </Box>
        );
      })}
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
