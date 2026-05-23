/**
 * TasksPanel — context-compacted lifecycle marker rendering.
 *
 * The `context-compacted` signal is a boundary, not a per-task entry: it renders dedented
 * (pulled left of the signal label column) and in `inkColors.muted` so it reads as a separator
 * inside the signal stream. These tests pin:
 *   - The marker label ("context compacted").
 *   - The optional parenthetical detail (token counts `before → after`, kept-topic count).
 *   - Graceful degradation when neither token counts nor topics are reported.
 *   - The width-driven ellipsis path — the marker body never overflows the available column.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { ContextCompactedSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

const ts = (n: number): IsoTimestamp => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString() as IsoTimestamp;

const compaction = (extras: Partial<ContextCompactedSignal> = {}): ContextCompactedSignal => ({
  type: 'context-compacted',
  timestamp: ts(0),
  ...extras,
});

const bucketWithSignals = (signals: readonly ContextCompactedSignal[]): BucketedExecution => ({
  tasks: [
    {
      id: 'task-1',
      status: 'running',
      subSteps: [],
      evaluations: [],
      signals,
      genEvalRound: 0,
    },
  ],
  orphanSignals: [],
});

describe('TasksPanel context-compacted marker', () => {
  it('renders a "context compacted" marker with token before/after and kept-topic count', () => {
    const sig = compaction({
      beforeTokens: 200_000,
      afterTokens: 12_000,
      preservedTopics: ['repo layout', 'open task', 'auth flow', 'test harness'],
    });

    const r = render(<TasksPanel bucketed={bucketWithSignals([sig])} running={true} />);
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('context compacted');
    expect(frame).toContain('200k');
    expect(frame).toContain('12k');
    expect(frame).toContain('kept: 4 topics');

    r.unmount();
  });

  it('uses singular "topic" when exactly one topic was preserved', () => {
    const sig = compaction({ beforeTokens: 1500, afterTokens: 800, preservedTopics: ['repo layout'] });

    const r = render(<TasksPanel bucketed={bucketWithSignals([sig])} running={true} />);
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('kept: 1 topic');
    // Verify it is NOT pluralized.
    expect(frame).not.toContain('kept: 1 topics');

    r.unmount();
  });

  it('renders the bare boundary when neither token counts nor topics are reported', () => {
    const sig = compaction();

    const r = render(<TasksPanel bucketed={bucketWithSignals([sig])} running={true} />);
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('context compacted');
    // No parenthetical detail block when there is nothing to show.
    expect(frame).not.toMatch(/context compacted \(/);

    r.unmount();
  });

  it('compaction marker stays inside the available column width (flexGrow + truncate-end)', () => {
    // ink-testing-library hardcodes stdout.columns=100. The flexGrow + truncate-end wrapper
    // bounds the marker body to that budget. A 50-item topic list absent the wrapper would
    // push the layout past 100; assert the hard cap holds.
    const sig = compaction({
      beforeTokens: 200_000,
      afterTokens: 12_000,
      preservedTopics: Array.from({ length: 50 }, (_, i) => `topic-with-a-very-long-name-${String(i)}`),
    });

    const r = render(<TasksPanel bucketed={bucketWithSignals([sig])} running={true} />);
    const frame = r.lastFrame() ?? '';
    const ansiRe = /\[[0-9;]*m/g;
    const longest = frame
      .split('\n')
      .map((l) => l.replace(ansiRe, '').length)
      .reduce((m, n) => Math.max(m, n), 0);
    expect(longest).toBeLessThanOrEqual(100);

    r.unmount();
  });

  it('does not surface context-compacted in the inline kinds bar (boundaries are not signal kinds)', () => {
    const sig = compaction({ beforeTokens: 1000, afterTokens: 500 });

    const r = render(<TasksPanel bucketed={bucketWithSignals([sig])} running={true} />);
    const frame = r.lastFrame() ?? '';

    // The kinds bar lists per-task signal label tokens (change / learning / commit / etc.).
    // The dedented boundary marker is not one of them; rowForSignal returns undefined so
    // collectKinds excludes it, and the kinds bar suppresses entirely when no kinds collected.
    expect(frame).not.toContain('kinds:');

    r.unmount();
  });
});
