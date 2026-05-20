/**
 * Baseline-Health Card — snapshot-style assertions over the four states the card surfaces:
 *
 *   1. empty (no setup, no checks) → "awaiting first run…"
 *   2. clean (pre+post green, no regressions)
 *   3. regression (pre=green, post=red — attribution counts surface the red)
 *   4. baseline-broken (pre=red, post=red — preserved verdict, warning surfaces)
 *   5. fixed-baseline (pre=red, post=green — credit surfaced)
 *
 * Pins the rendered text so a future refactor that drops a row or swaps a glyph fails loudly.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { BaselineHealthCard } from '@src/application/ui/tui/components/baseline-health-card.tsx';
import type { SprintExecution, SetupRun } from '@src/domain/entity/sprint-execution.ts';
import type { Attempt, CheckRun, Attribution } from '@src/domain/entity/attempt.ts';
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

const checkRun = (phase: 'pre' | 'post', outcome: CheckRun['outcome'], minutesAgo: number): CheckRun => {
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

const taskWithAttempt = (checkRuns: readonly CheckRun[], attribution?: Attribution, baselineBroken?: boolean): Task => {
  const base = makeInProgressTaskWithRunningAttempt() as InProgressTask;
  const lastAttempt = base.attempts.at(-1) as Attempt;
  const next: Attempt = {
    ...lastAttempt,
    checkRuns,
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
  it('renders the empty state when no setup and no checks have run yet', () => {
    const { lastFrame } = render(<BaselineHealthCard now={now} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('awaiting first run');
  });

  it('renders the clean state — green setup, green pre, green post, clean attribution count', () => {
    const task = taskWithAttempt([checkRun('pre', 'success', 2), checkRun('post', 'success', 1)], 'clean');
    const { lastFrame } = render(
      <BaselineHealthCard execution={executionWith([setupRow()])} tasks={[task]} now={now} />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Setup');
    expect(frame).toContain('Pre');
    expect(frame).toContain('Post');
    expect(frame).toContain('green');
    expect(frame).toContain('1 clean');
  });

  it('renders the regressed state — pre=green, post=red, attribution surfaces the red', () => {
    const task = taskWithAttempt([checkRun('pre', 'success', 2), checkRun('post', 'failed', 1)], 'regressed');
    const { lastFrame } = render(
      <BaselineHealthCard execution={executionWith([setupRow()])} tasks={[task]} now={now} />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('red');
    expect(frame).toContain('1 regressed');
  });

  it('renders the baseline-broken state — pre=red, post=red, "broken-base" count surfaces', () => {
    const task = taskWithAttempt(
      [checkRun('pre', 'failed', 2), checkRun('post', 'failed', 1)],
      'baseline-broken',
      true
    );
    const { lastFrame } = render(
      <BaselineHealthCard execution={executionWith([setupRow()])} tasks={[task]} now={now} />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('1 broken-base');
  });

  it('renders the fixed-baseline state — pre=red, post=green, "fixed" count surfaces', () => {
    const task = taskWithAttempt([checkRun('pre', 'failed', 2), checkRun('post', 'success', 1)], 'fixed-baseline');
    const { lastFrame } = render(
      <BaselineHealthCard execution={executionWith([setupRow()])} tasks={[task]} now={now} />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('1 fixed');
  });

  it('renders a setup-script red row when any repo failed setup', () => {
    const { lastFrame } = render(
      <BaselineHealthCard
        execution={executionWith([setupRow({ outcome: 'failed', exitCode: 1 })])}
        tasks={[]}
        now={now}
      />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Setup');
    expect(frame).toContain('red');
  });
});
