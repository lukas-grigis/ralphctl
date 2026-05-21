/**
 * Baseline-Health Chip — the single-line companion to BaselineHealthCard. Renders above the
 * active-task header. Verifies tier synthesis:
 *
 *   - red    — any regression, any red setup, any red VerifyRun.
 *   - amber  — broken-baseline attempts OR stale (last check > STALE_MS ago).
 *   - green  — at least one check has run and nothing's red.
 *   - unknown — no setup, no checks (initial state).
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { BaselineHealthChip } from '@src/application/ui/tui/components/baseline-health-chip.tsx';
import type { SprintExecution, SetupRun } from '@src/domain/entity/sprint-execution.ts';
import type { Attempt, VerifyRun, Attribution } from '@src/domain/entity/attempt.ts';
import type { Task, InProgressTask } from '@src/domain/entity/task.ts';
import {
  FIXED_NOW,
  FIXED_REPOSITORY_ID,
  isoTimestamp,
  makeInProgressTaskWithRunningAttempt,
} from '@tests/fixtures/domain.ts';

const sprintId = 'sprint-1' as never;

const setupRow = (outcome: SetupRun['outcome']): SetupRun => ({
  repositoryId: FIXED_REPOSITORY_ID,
  ranAt: FIXED_NOW,
  command: 'pnpm install',
  exitCode: outcome === 'success' ? 0 : -1,
  durationMs: 0,
  stdoutTailBytes: '',
  stderrTailBytes: '',
  outcome,
});

const executionWith = (setupRanAt: readonly SetupRun[]): SprintExecution => ({
  id: sprintId,
  sprintId,
  branch: null,
  pullRequestUrl: null,
  setupRanAt,
});

const verifyRun = (phase: 'pre' | 'post', outcome: VerifyRun['outcome'], minutesAgo: number): VerifyRun => ({
  phase,
  ranAt: isoTimestamp(new Date(new Date(FIXED_NOW).getTime() - minutesAgo * 60_000).toISOString()),
  command: 'pnpm test',
  exitCode: outcome === 'success' ? 0 : 1,
  durationMs: 0,
  stdoutTailBytes: '',
  outcome,
});

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

describe('BaselineHealthChip', () => {
  it('renders the "awaiting first run" pill when nothing has happened yet', () => {
    const { lastFrame } = render(<BaselineHealthChip now={now} />);
    expect(lastFrame() ?? '').toContain('awaiting');
  });

  it('renders green when at least one check has run and nothing is red', () => {
    const task = taskWithAttempt([verifyRun('pre', 'success', 2), verifyRun('post', 'success', 1)], 'clean');
    const { lastFrame } = render(
      <BaselineHealthChip execution={executionWith([setupRow('success')])} tasks={[task]} now={now} />
    );
    expect(lastFrame() ?? '').toContain('green');
  });

  it('renders red when there is a regression', () => {
    const task = taskWithAttempt([verifyRun('pre', 'success', 2), verifyRun('post', 'failed', 1)], 'regressed');
    const { lastFrame } = render(
      <BaselineHealthChip execution={executionWith([setupRow('success')])} tasks={[task]} now={now} />
    );
    expect(lastFrame() ?? '').toContain('red');
    expect(lastFrame() ?? '').toContain('regression');
  });

  it('renders amber for broken-baseline attempts', () => {
    const task = taskWithAttempt(
      [verifyRun('pre', 'failed', 2), verifyRun('post', 'failed', 1)],
      'baseline-broken',
      true
    );
    const { lastFrame } = render(
      <BaselineHealthChip execution={executionWith([setupRow('skipped')])} tasks={[task]} now={now} />
    );
    expect(lastFrame() ?? '').toContain('broken-base');
  });

  it('renders red for a failed setup-script row', () => {
    const { lastFrame } = render(
      <BaselineHealthChip execution={executionWith([setupRow('failed')])} tasks={[]} now={now} />
    );
    expect(lastFrame() ?? '').toContain('red');
  });
});
