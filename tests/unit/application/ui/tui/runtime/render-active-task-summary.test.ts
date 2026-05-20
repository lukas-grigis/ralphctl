/**
 * Tests for the markdown summary copied to the clipboard by the `y` (yank) hotkey. Each test
 * synthesises a minimal `TaskBucket` directly — we don't run the full bucketTaskSignals
 * pipeline because the renderer is pure over the bucket shape.
 */

import { describe, expect, it } from 'vitest';
import { renderActiveTaskSummary } from '@src/application/ui/tui/runtime/render-active-task-summary.ts';
import type { TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { HarnessSignal, EvaluationSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

const ts = (s: string): IsoTimestamp => s as unknown as IsoTimestamp;

const baseBucket = (overrides: Partial<TaskBucket> = {}): TaskBucket => ({
  id: 'task-1',
  status: 'running',
  subSteps: [],
  evaluations: [],
  signals: [],
  genEvalRound: 1,
  ...overrides,
});

describe('renderActiveTaskSummary', () => {
  it('renders a minimal heading + status + zero-count signal line', () => {
    const out = renderActiveTaskSummary({ task: baseBucket(), displayName: 'Implement clipboard' });
    expect(out).toContain('### Implement clipboard');
    expect(out).toContain('- status: running');
    expect(out).toContain('- attempts: 0');
    expect(out).toContain('- signals: change 0, learning 0, decision 0, verified 0, blocked 0, commit 0');
    // No commit signal yet — no last-commit line.
    expect(out).not.toContain('- last commit:');
  });

  it('annotates the latest evaluation verdict', () => {
    const evaluation: EvaluationSignal = {
      type: 'evaluation',
      status: 'failed',
      dimensions: [],
      critique: 'incomplete',
      timestamp: ts('2026-05-08T10:00:00.000Z'),
    };
    const out = renderActiveTaskSummary({
      task: baseBucket({ evaluations: [evaluation] }),
      displayName: 'task',
    });
    expect(out).toContain('- attempts: 1 (last: failed)');
  });

  it('counts focusable signal kinds and surfaces the sha from the harness-resolved commit', () => {
    const signals: HarnessSignal[] = [
      { type: 'change', text: 'edit x', timestamp: ts('2026-05-08T10:00:00.000Z') },
      { type: 'change', text: 'edit y', timestamp: ts('2026-05-08T10:00:01.000Z') },
      { type: 'learning', text: 'l', timestamp: ts('2026-05-08T10:00:02.000Z') },
      { type: 'decision', text: 'd', timestamp: ts('2026-05-08T10:00:03.000Z') },
      {
        type: 'commit-message',
        subject: 'feat: x',
        fullMessage: 'feat: x\n\nbody\n\ncommit deadbeefcafef00d1234567890abcdef12345678',
        timestamp: ts('2026-05-08T10:00:04.000Z'),
      },
    ];
    const out = renderActiveTaskSummary({
      task: baseBucket({ signals }),
      displayName: 'task',
    });
    expect(out).toContain('- last commit: deadbeefcafef00d1234567890abcdef12345678');
    expect(out).toContain('- signals: change 2, learning 1, decision 1, verified 0, blocked 0, commit 1');
  });

  it('ignores commit-message signals that have not been resolved by the harness yet', () => {
    const signals: HarnessSignal[] = [
      { type: 'commit-message', subject: 'parse-time only', timestamp: ts('2026-05-08T10:00:04.000Z') },
    ];
    const out = renderActiveTaskSummary({ task: baseBucket({ signals }), displayName: 'task' });
    expect(out).not.toContain('- last commit:');
    expect(out).toContain('- signals: change 0, learning 0, decision 0, verified 0, blocked 0, commit 1');
  });
});
