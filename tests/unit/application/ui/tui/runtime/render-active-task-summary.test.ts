/**
 * Tests for the markdown summary copied to the clipboard by the `y` (yank) hotkey. Each test
 * synthesises a minimal `TaskBucket` directly — we don't run the full bucketTaskSignals
 * pipeline because the renderer is pure over the bucket shape.
 */

import { describe, expect, it } from 'vitest';
import { renderActiveTaskSummary } from '@src/application/ui/tui/runtime/render-active-task-summary.ts';
import type { TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { EvaluationSignal, HarnessSignal } from '@src/domain/signal.ts';
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

  it('counts focusable signal kinds across the bucket', () => {
    const signals: HarnessSignal[] = [
      { type: 'change', text: 'edit x', timestamp: ts('2026-05-08T10:00:00.000Z') },
      { type: 'change', text: 'edit y', timestamp: ts('2026-05-08T10:00:01.000Z') },
      { type: 'learning', text: 'l', timestamp: ts('2026-05-08T10:00:02.000Z') },
      { type: 'decision', text: 'd', timestamp: ts('2026-05-08T10:00:03.000Z') },
      { type: 'commit-message', subject: 'feat: x', timestamp: ts('2026-05-08T10:00:04.000Z') },
    ];
    const out = renderActiveTaskSummary({
      task: baseBucket({ signals }),
      displayName: 'task',
    });
    expect(out).toContain('- signals: change 2, learning 1, decision 1, verified 0, blocked 0, commit 1');
    // SHA is not threaded through the bucket post-Wave-6 — drop the line entirely.
    expect(out).not.toContain('- last commit:');
  });
});
