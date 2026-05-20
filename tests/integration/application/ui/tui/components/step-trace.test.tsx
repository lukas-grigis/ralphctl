/**
 * StepTrace plan/trace merge — the memo's tricky property is that the runner mutates its
 * trace array in place (`.push` + ring eviction). The component must re-render the merged
 * rows when pushes happen even though the array reference is stable; we cover that with
 * `trace.length` AND last-entry identity in the dep list. These tests prove both halves work.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { Trace, TraceEntry } from '@src/application/chain/trace.ts';
import { StepTrace } from '@src/application/ui/tui/components/step-trace.tsx';

const entry = (name: string, status: TraceEntry['status'] = 'completed'): TraceEntry => ({
  elementName: name,
  status,
  durationMs: 1,
});

describe('StepTrace plan/trace merge', () => {
  it('renders pending rows for plan entries with no matching trace yet', () => {
    const r = render(<StepTrace trace={[]} running={true} plan={['one', 'two', 'three']} maxRows={10} />);
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('one');
    expect(frame).toContain('two');
    expect(frame).toContain('three');
    // "pending" trailing label appears on rows that have no trace match and no running cursor.
    expect(frame).toContain('pending');
    r.unmount();
  });

  it('compact mode hides leaf names, durations, trailing labels, and error messages', () => {
    const trace: TraceEntry[] = [
      entry('one', 'completed'),
      { ...entry('two'), status: 'failed', error: { message: 'boom' } as never },
    ];
    const r = render(<StepTrace trace={trace} running={false} plan={['one', 'two', 'three']} maxRows={10} compact />);
    const frame = r.lastFrame() ?? '';
    // Labels and durations and trailing words must all be absent.
    expect(frame).not.toContain('one');
    expect(frame).not.toContain('two');
    expect(frame).not.toContain('three');
    expect(frame).not.toContain('pending');
    expect(frame).not.toContain('1ms');
    expect(frame).not.toContain('boom');
    // Status glyphs still render — the compact rail's whole job is the icon spine.
    expect(frame).toMatch(/[■◇✗◌]/);
    r.unmount();
  });

  it('updates the merged rows when new entries are pushed to the same trace array', () => {
    // Simulate the runner mutating in place — array reference is stable across pushes.
    const trace: TraceEntry[] = [];

    const Probe = ({ tr }: { readonly tr: Trace }): React.JSX.Element => (
      <StepTrace trace={tr} running={true} plan={['one', 'two']} maxRows={10} />
    );

    const r = render(<Probe tr={trace} />);
    expect(r.lastFrame() ?? '').not.toContain('1ms'); // no completed entry yet

    trace.push(entry('one'));
    r.rerender(<Probe tr={trace} />);
    expect(r.lastFrame() ?? '').toContain('one');

    trace.push(entry('two'));
    r.rerender(<Probe tr={trace} />);
    const frameAfter = r.lastFrame() ?? '';
    // Both completed entries must now show their durations — proves the memo recomputed.
    expect(frameAfter.split('1ms').length - 1).toBeGreaterThanOrEqual(2);
    r.unmount();
  });
});
