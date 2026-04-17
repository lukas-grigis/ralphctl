import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import type { StepExecutionRecord } from '@src/business/pipelines/framework/types.ts';
import { PhaseRunTrace } from './phase-run-trace.tsx';
import { ParseError } from '@src/domain/errors.ts';

describe('PhaseRunTrace', () => {
  it('renders a placeholder when the trace is empty', () => {
    const { lastFrame } = render(<PhaseRunTrace records={[]} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Last run');
    expect(frame).toContain('no runs yet');
  });

  it('renders one row per step with glyph and duration', () => {
    const records: StepExecutionRecord[] = [
      { stepName: 'load-sprint', status: 'success', durationMs: 42 },
      { stepName: 'refine-tickets', status: 'success', durationMs: 4320 },
    ];
    const { lastFrame } = render(<PhaseRunTrace records={records} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('load-sprint');
    expect(frame).toContain('42ms');
    expect(frame).toContain('refine-tickets');
    expect(frame).toContain('4.3s');
  });

  it('surfaces the error message when a step failed', () => {
    const records: StepExecutionRecord[] = [
      { stepName: 'load-sprint', status: 'success', durationMs: 5 },
      {
        stepName: 'assert-draft',
        status: 'failed',
        durationMs: 1,
        error: new ParseError('Sprint is not in draft status'),
      },
    ];
    const { lastFrame } = render(<PhaseRunTrace records={records} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('assert-draft');
    expect(frame).toContain('Sprint is not in draft status');
  });

  it('accepts a custom title', () => {
    const { lastFrame } = render(<PhaseRunTrace records={[]} title="Planning trace" />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Planning trace');
  });

  it('formats minute-scale durations as m:ss', () => {
    const records: StepExecutionRecord[] = [{ stepName: 'run-plan', status: 'success', durationMs: 125_000 }];
    const { lastFrame } = render(<PhaseRunTrace records={records} />);
    expect(lastFrame() ?? '').toContain('2m05s');
  });
});
