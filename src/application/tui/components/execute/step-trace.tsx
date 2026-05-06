/**
 * StepTrace — renders the outer chain trace entries (load-sprint,
 * assert-active, etc.) for the execute view.
 *
 * Per-task child steps (`task-<id>`) are intentionally excluded here
 * and rendered by TaskExecutionGrid instead.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors } from '@src/integration/ui/theme/tokens.ts';
import { Spinner } from '@src/application/tui/components/spinner.tsx';
import type { ChainTraceEntry } from '@src/kernel/chain/element.ts';

export interface LiveStep {
  readonly name: string;
  readonly status: ChainTraceEntry['status'] | undefined;
  readonly durationMs: number | undefined;
  readonly errorMessage: string | undefined;
}

interface StepTraceProps {
  readonly steps: readonly LiveStep[];
  readonly isRunning: boolean;
}

function durationLabel(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function useSpinnerFrame(intervalMs = 90): number {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % glyphs.spinner.length);
    }, intervalMs);
    return () => {
      clearInterval(id);
    };
  }, [intervalMs]);
  return frame;
}

function stepGlyph(status: ChainTraceEntry['status'] | undefined, spinnerFrame: number): React.JSX.Element {
  if (status === undefined)
    return (
      <Text color={inkColors.warning} bold>
        {glyphs.spinner[spinnerFrame] ?? glyphs.phaseActive}
      </Text>
    );
  if (status === 'completed')
    return (
      <Text color={inkColors.success} bold>
        {glyphs.phaseDone}
      </Text>
    );
  if (status === 'failed')
    return (
      <Text color={inkColors.error} bold>
        {glyphs.cross}
      </Text>
    );
  if (status === 'aborted')
    return (
      <Text color={inkColors.muted} bold>
        {glyphs.emDash}
      </Text>
    );
  // 'skipped'
  return (
    <Text color={inkColors.muted} bold>
      {glyphs.phasePending}
    </Text>
  );
}

// Cap visible rows so a long-running chain (hundreds of per-task leaves)
// can't grow the parent <Box>'s childNodes into the thousands. Ink calls
// `[...childNodes].reverse()` per render; with a 90 ms spinner heartbeat
// driving re-renders, an unbounded child list thrashes the heap to OOM.
export const MAX_RENDERED_STEPS = 50;

export function StepTrace({ steps, isRunning }: StepTraceProps): React.JSX.Element {
  const spinnerFrame = useSpinnerFrame();
  if (steps.length === 0) {
    if (isRunning) return <Spinner label="Starting…" />;
    return <Text dimColor>No steps recorded.</Text>;
  }
  const visible = steps.length > MAX_RENDERED_STEPS ? steps.slice(-MAX_RENDERED_STEPS) : steps;
  const elided = steps.length - visible.length;
  return (
    <Box flexDirection="column">
      {elided > 0 ? <Text dimColor>{`… ${String(elided)} earlier steps`}</Text> : null}
      {visible.map((step, i) => (
        <Box key={i}>
          {stepGlyph(step.status, spinnerFrame)}
          <Text bold={step.status === undefined}>{`  ${step.name}`}</Text>
          {step.durationMs !== undefined ? (
            <Text dimColor>{`  ${glyphs.inlineDot} ${durationLabel(step.durationMs)}`}</Text>
          ) : null}
          {step.errorMessage ? <Text color={inkColors.error}>{`  ${glyphs.emDash} ${step.errorMessage}`}</Text> : null}
        </Box>
      ))}
    </Box>
  );
}

/**
 * Compact end-of-run summary — replaces the verbose StepTrace once the
 * chain is terminal. A typical execute run produces 13+ outer step
 * entries; on a 30-row terminal that pushes the result card + task grid
 * + recent events off-screen, leaving the user staring at an apparently
 * empty bottom of the screen.
 *
 * Renders one tally line plus any failed steps inline (the user always
 * needs to see what failed). Skipped/aborted steps roll into the tally.
 */
export function CompactStepSummary({ steps }: { readonly steps: readonly LiveStep[] }): React.JSX.Element {
  if (steps.length === 0) return <Text dimColor>No steps recorded.</Text>;
  const completed = steps.filter((s) => s.status === 'completed').length;
  const failed = steps.filter((s) => s.status === 'failed');
  const aborted = steps.filter((s) => s.status === 'aborted').length;
  const skipped = steps.filter((s) => s.status === 'skipped').length;
  const totalMs = steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);

  const parts: string[] = [`${String(steps.length)} steps`];
  parts.push(`${String(completed)} completed`);
  if (failed.length > 0) parts.push(`${String(failed.length)} failed`);
  if (aborted > 0) parts.push(`${String(aborted)} aborted`);
  if (skipped > 0) parts.push(`${String(skipped)} skipped`);
  if (totalMs > 0) parts.push(durationLabel(totalMs));

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={failed.length > 0 ? inkColors.error : inkColors.success} bold>
          {failed.length > 0 ? glyphs.cross : glyphs.phaseDone}
        </Text>
        <Text>{`  ${parts.join(`  ${glyphs.inlineDot}  `)}`}</Text>
      </Box>
      {failed.map((step, i) => (
        <Box key={`f-${String(i)}`} paddingLeft={2}>
          <Text color={inkColors.error} bold>
            {glyphs.cross}
          </Text>
          <Text>{`  ${step.name}`}</Text>
          {step.errorMessage ? <Text color={inkColors.error}>{`  ${glyphs.emDash} ${step.errorMessage}`}</Text> : null}
        </Box>
      ))}
    </Box>
  );
}
