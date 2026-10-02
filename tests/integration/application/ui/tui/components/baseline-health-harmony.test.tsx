/**
 * Harmony tests — render BaselineHealthChip and BaselineHealthCard against the SAME inputs and
 * assert they never disagree. The bug these tests guard against: the chip used to flag "any
 * historical red verify" while the card already showed only the latest run per phase, so a
 * red → green transition left the chip stuck on red and the card green. The shared predicate
 * eliminates that drift.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { BaselineHealthCard } from '@src/application/ui/tui/components/baseline-health-card.tsx';
import { BaselineHealthChip } from '@src/application/ui/tui/components/baseline-health-chip.tsx';
import type { SetupRun, SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { Attempt, Attribution, VerifyRun } from '@src/domain/entity/attempt.ts';
import type { InProgressTask, Task } from '@src/domain/entity/task.ts';
import {
  FIXED_NOW,
  FIXED_REPOSITORY_ID,
  isoTimestamp,
  makeInProgressTaskWithRunningAttempt,
} from '@tests/fixtures/domain.ts';

const sprintId = 'sprint-1' as never;

const setupRow = (outcome: SetupRun['outcome'] = 'success'): SetupRun => ({
  repositoryId: FIXED_REPOSITORY_ID,
  ranAt: FIXED_NOW,
  command: 'pnpm install',
  exitCode: outcome === 'success' ? 0 : -1,
  durationMs: 0,
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
  outcome,
});

/**
 * Build a multi-attempt task: attempt N=1 carries `attempt1VerifyRuns` and settles as `failed`;
 * attempt N=2 is the running attempt carrying `attempt2VerifyRuns`. Lets a single task show
 * "earlier attempt was red, latest attempt is green" — the exact bug fixture.
 */
const taskWithTwoAttempts = (
  attempt1VerifyRuns: readonly VerifyRun[],
  attempt2VerifyRuns: readonly VerifyRun[],
  options: { readonly attribution?: Attribution; readonly baselineBroken?: boolean } = {}
): Task => {
  const base = makeInProgressTaskWithRunningAttempt() as InProgressTask;
  const runningAttempt = base.attempts.at(-1) as Attempt;
  const firstAttempt: Attempt = {
    ...runningAttempt,
    n: 1,
    status: 'failed',
    finishedAt: runningAttempt.startedAt,
    verifyRuns: attempt1VerifyRuns,
  };
  const secondAttempt: Attempt = {
    ...runningAttempt,
    n: 2,
    verifyRuns: attempt2VerifyRuns,
    ...(options.attribution !== undefined ? { attribution: options.attribution } : {}),
    ...(options.baselineBroken !== undefined ? { baselineBroken: options.baselineBroken } : {}),
  };
  return {
    ...base,
    attempts: [firstAttempt, secondAttempt],
  };
};

const taskWithAttempt = (
  verifyRuns: readonly VerifyRun[],
  options: { readonly attribution?: Attribution; readonly baselineBroken?: boolean } = {}
): Task => {
  const base = makeInProgressTaskWithRunningAttempt() as InProgressTask;
  const lastAttempt = base.attempts.at(-1) as Attempt;
  const next: Attempt = {
    ...lastAttempt,
    verifyRuns,
    ...(options.attribution !== undefined ? { attribution: options.attribution } : {}),
    ...(options.baselineBroken !== undefined ? { baselineBroken: options.baselineBroken } : {}),
  };
  return {
    ...base,
    attempts: [...base.attempts.slice(0, -1), next],
  };
};

const now = new Date(FIXED_NOW).getTime();

const renderBoth = (
  task: Task,
  execution: SprintExecution = executionWith([setupRow()])
): { chip: string; card: string } => {
  const chip = render(<BaselineHealthChip execution={execution} tasks={[task]} now={now} />).lastFrame() ?? '';
  const card = render(<BaselineHealthCard execution={execution} tasks={[task]} now={now} />).lastFrame() ?? '';
  return { chip, card };
};

describe('BaselineHealthChip / BaselineHealthCard harmony', () => {
  it('red → green transition: attempt-1 pre-verify failed, attempt-2 pre-verify success ⇒ both green', () => {
    // The repro fixture from the bug report. Attempt 1 hit a red pre-verify (and was aborted);
    // attempt 2's pre-verify came back green. The card had always shown only the latest run
    // per phase, so it read green. The chip's old `anyRedVerify` walked every attempt's
    // verifyRuns and stayed stuck on red. After the shared latest-wins predicate they agree.
    const task = taskWithTwoAttempts(
      [verifyRun('pre', 'failed', 30)],
      [verifyRun('pre', 'success', 2), verifyRun('post', 'success', 1)],
      { attribution: 'clean' }
    );
    const { chip, card } = renderBoth(task);
    expect(chip).toContain('green');
    // Card title reflects an ok state (clean compact variant) when every row is ok.
    expect(card).toContain('clean');
  });

  it('latest post-verify red while latest pre-verify green ⇒ both red', () => {
    const task = taskWithAttempt([verifyRun('pre', 'success', 2), verifyRun('post', 'failed', 1)]);
    const { chip, card } = renderBoth(task);
    expect(chip).toContain('red');
    // The card surfaces the failing post-verify row.
    expect(card).toContain('Post verify');
    expect(card).toContain('failed');
  });

  it('alternating red/green pre-verify across attempts ⇒ both reflect the latest only', () => {
    // Attempt 1: pre red. Attempt 2: pre green. With latest-wins the historical red is
    // ignored on both surfaces. Without latest-wins the chip would still show red.
    const task = taskWithTwoAttempts([verifyRun('pre', 'failed', 30)], [verifyRun('pre', 'success', 2)], {
      attribution: 'clean',
    });
    const { chip, card } = renderBoth(task);
    expect(chip).toContain('green');
    // Card should not declare the run failed in its title.
    expect(card).not.toContain('failed');
  });

  it('empty verifyRuns on latest attempt ⇒ both surfaces show the same fallback', () => {
    // No verify rows on either attempt. With a green setup row both surfaces should land in
    // the "nothing red, has run" state — chip reads green, card title omits any red suffix.
    const task = taskWithTwoAttempts([], []);
    const { chip, card } = renderBoth(task);
    expect(chip).toContain('green');
    expect(card).not.toContain('failed');
  });

  it('agreement preserved on hard-red regression', () => {
    const task = taskWithAttempt([verifyRun('pre', 'success', 2), verifyRun('post', 'failed', 1)], {
      attribution: 'regressed',
    });
    const { chip, card } = renderBoth(task);
    expect(chip).toContain('red');
    expect(chip).toContain('regression');
    // Card shows the failed post-verify row.
    expect(card).toContain('failed');
  });
});
