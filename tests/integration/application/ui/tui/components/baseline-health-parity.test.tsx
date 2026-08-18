/**
 * Parity fence — the TUI's `countAttributions` and the business fold's attribution block are the
 * SAME numbers. Before this seam existed the TUI hand-rolled its own double loop, so the live
 * execute-view chip could disagree with `ralphctl runs stats` over the same sprint. The counting
 * now lives in `business/runs/outcome-stats.ts`; only the tier PRECEDENCE stays in the TUI.
 *
 * The second test is the tolerance dividend: the hand-rolled loop indexed `task.attempts`
 * unguarded and threw on a legacy row that predates the field. The fold's tolerant reads mean the
 * render path survives it.
 */

import { describe, expect, it } from 'vitest';
import { countAttributions, synthesiseBaselineHealth } from '@src/application/ui/tui/components/baseline-health.ts';
import { foldTaskRollup } from '@src/business/runs/outcome-stats.ts';
import type { Attempt, Attribution } from '@src/domain/entity/attempt.ts';
import type { InProgressTask, Task } from '@src/domain/entity/task.ts';
import { FIXED_NOW, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';

/** One task whose attempts carry the given attribution values (`undefined` = never stamped). */
const taskWithAttributions = (attributions: ReadonlyArray<Attribution | undefined | string>): Task => {
  const base = makeInProgressTaskWithRunningAttempt() as InProgressTask;
  const template = base.attempts.at(-1) as Attempt;
  const attempts = attributions.map((attribution, index) => ({
    ...template,
    n: index + 1,
    ...(attribution === undefined ? {} : { attribution: attribution as Attribution }),
  }));
  return { ...base, attempts };
};

describe('countAttributions — parity with the business fold', () => {
  it('returns exactly the fold’s attribution byVerdict projection', () => {
    const tasks = [
      taskWithAttributions(['clean', 'regressed', 'fixed-baseline', 'baseline-broken']),
      // One never-attributed attempt and one written by a version this build has never seen.
      taskWithAttributions([undefined, 'flaky']),
    ];

    const { byVerdict } = foldTaskRollup(tasks).attribution;

    expect(countAttributions(tasks)).toEqual({
      clean: byVerdict.clean,
      regressed: byVerdict.regressed,
      fixedBaseline: byVerdict['fixed-baseline'],
      baselineBroken: byVerdict['baseline-broken'],
    });
    expect(countAttributions(tasks)).toEqual({ clean: 1, regressed: 1, fixedBaseline: 1, baselineBroken: 1 });
  });
});

describe('synthesiseBaselineHealth — legacy tolerance', () => {
  it('does not throw on a persisted task that carries no attempts array at all', () => {
    const legacy = { id: 'legacy', name: 'legacy', status: 'todo', order: 1 } as unknown as Task;

    expect(() => synthesiseBaselineHealth({ tasks: [legacy], now: new Date(FIXED_NOW).getTime() })).not.toThrow();
  });
});
