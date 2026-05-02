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

export function StepTrace({ steps, isRunning }: StepTraceProps): React.JSX.Element {
  const spinnerFrame = useSpinnerFrame();
  if (steps.length === 0) {
    if (isRunning) return <Spinner label="Starting…" />;
    return <Text dimColor>No steps recorded.</Text>;
  }
  return (
    <Box flexDirection="column">
      {steps.map((step, i) => (
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
