/**
 * Baseline-Health Card — snapshot-style assertions over the states the card surfaces.
 *
 * States under test:
 *   1. empty (no setup, no verifies) → "awaiting first run…"
 *   2. all-clean (pre+post green, clean attribution) → compact one-line variant
 *   3. regression (pre=green, post=red) → expanded; Setup bold, "Attribution" shows broken count
 *   4. baseline-broken (pre=red, post=red) → expanded; warning tone; "broken" in attribution
 *   5. fixed-baseline (pre=red, post=green) → expanded; "fixed" in attribution sub-line
 *   6. setup-failed → expanded; "Setup · failed" in error tier; bold label
 *   7. pending-only (setup ran, no verifies) → expanded; Pre-task/Post-task show "not run yet"
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { BaselineHealthCard } from '@src/application/ui/tui/components/baseline-health-card.tsx';
import type { SprintExecution, SetupRun } from '@src/domain/entity/sprint-execution.ts';
import type { Attempt, VerifyRun, Attribution } from '@src/domain/entity/attempt.ts';
import type { Task, InProgressTask } from '@src/domain/entity/task.ts';
import {
  FIXED_NOW,
  FIXED_REPOSITORY_ID,
  isoTimestamp,
  makeInProgressTaskWithRunningAttempt,
} from '@tests/fixtures/domain.ts';

const sprintId = 'sprint-1' as never; // structural only; the card doesn't introspect it

const setupRow = (overrides: Partial<SetupRun> = {}): SetupRun => ({
  repositoryId: FIXED_REPOSITORY_ID,
  ranAt: FIXED_NOW,
  command: 'pnpm install',
  exitCode: 0,
  durationMs: 100,
  stdoutTailBytes: '',
  stderrTailBytes: '',
  outcome: 'success',
  ...overrides,
});

const executionWith = (setupRanAt: readonly SetupRun[]): SprintExecution => ({
  id: sprintId,
  sprintId,
  branch: null,
  pullRequestUrl: null,
  setupRanAt,
});

const verifyRun = (phase: 'pre' | 'post', outcome: VerifyRun['outcome'], minutesAgo: number): VerifyRun => {
  const ranAt = isoTimestamp(new Date(new Date(FIXED_NOW).getTime() - minutesAgo * 60_000).toISOString());
  return {
    phase,
    ranAt,
    command: 'pnpm test',
    exitCode: outcome === 'success' ? 0 : outcome === 'spawn-error' ? -1 : 1,
    durationMs: 50,
    stdoutTailBytes: outcome === 'failed' ? 'broken' : '',
    outcome,
  };
};

const taskWithAttempt = (
  verifyRuns: readonly VerifyRun[],
  attribution?: Attribution,
  baselineBroken?: boolean
): Task => {
  const base = makeInProgressTaskWithRunningAttempt() as InProgressTask;
  const lastAttempt = base.attempts.at(-1) as Attempt;
  const next: Attempt = {
    ...lastAttempt,
    verifyRuns,
    ...(attribution !== undefined ? { attribution } : {}),
    ...(baselineBroken !== undefined ? { baselineBroken } : {}),
  };
  return {
    ...base,
    attempts: [...base.attempts.slice(0, -1), next],
  };
};

const now = new Date(FIXED_NOW).getTime();

describe('BaselineHealthCard', () => {
  it('renders the empty state when no setup and no verifies have run yet', () => {
    const { lastFrame } = render(<BaselineHealthCard now={now} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('awaiting first run');
  });

  it('renders the compact all-clean variant when every indicator is ok', () => {
    const task = taskWithAttempt([verifyRun('pre', 'success', 2), verifyRun('post', 'success', 1)], 'clean');
    const { lastFrame } = render(
      <BaselineHealthCard execution={executionWith([setupRow()])} tasks={[task]} now={now} />
    );
    const frame = lastFrame() ?? '';
    // Title should read "Baseline · clean"
    expect(frame).toContain('Baseline');
    expect(frame).toContain('clean');
    // All four ticks should appear
    expect(frame).toContain('✓');
    // Compact variant uses abbreviated labels to fit the narrow card width
    expect(frame).toContain('Stp');
    expect(frame).toContain('Pre');
    expect(frame).toContain('Post');
    expect(frame).toContain('Att');
  });

  it('renders the regressed state — post=red, attribution shows broken count', () => {
    const task = taskWithAttempt([verifyRun('pre', 'success', 2), verifyRun('post', 'failed', 1)], 'regressed');
    const { lastFrame } = render(
      <BaselineHealthCard execution={executionWith([setupRow()])} tasks={[task]} now={now} />
    );
    const frame = lastFrame() ?? '';
    // Post verify row should show "failed"
    expect(frame).toContain('Post verify');
    expect(frame).toContain('failed');
    // Attribution sub-line includes "broken"
    expect(frame).toContain('broken');
  });

  it('renders the baseline-broken state — pre=red, post=red, "broken" count in attribution', () => {
    const task = taskWithAttempt(
      [verifyRun('pre', 'failed', 2), verifyRun('post', 'failed', 1)],
      'baseline-broken',
      true
    );
    const { lastFrame } = render(
      <BaselineHealthCard execution={executionWith([setupRow()])} tasks={[task]} now={now} />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('broken');
  });

  it('renders the fixed-baseline state — "fixed" appears in attribution sub-line', () => {
    const task = taskWithAttempt([verifyRun('pre', 'failed', 2), verifyRun('post', 'success', 1)], 'fixed-baseline');
    const { lastFrame } = render(
      <BaselineHealthCard execution={executionWith([setupRow()])} tasks={[task]} now={now} />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('fixed');
  });

  it('renders setup failure with "failed" status — expanded view, error tier', () => {
    const { lastFrame } = render(
      <BaselineHealthCard
        execution={executionWith([setupRow({ outcome: 'failed', exitCode: 1 })])}
        tasks={[]}
        now={now}
      />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Setup');
    expect(frame).toContain('failed');
    // Title should mention "setup failed"
    expect(frame).toContain('setup failed');
  });

  it('renders pending-only state when setup ran but no verifies have run', () => {
    const { lastFrame } = render(<BaselineHealthCard execution={executionWith([setupRow()])} tasks={[]} now={now} />);
    const frame = lastFrame() ?? '';
    // Pre and Post rows should be visible with "not run yet" status
    expect(frame).toContain('Pre verify');
    expect(frame).toContain('Post verify');
    expect(frame).toContain('not run yet');
  });
});
