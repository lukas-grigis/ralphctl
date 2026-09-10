/**
 * `computeTaskHealthCounts` is the one place that derives blocked-task health from a task list —
 * shared by Home's `ActiveSprintCard`, the Sprints list, the sprint picker, and the settled
 * Execute-view ResultCard (via `next-steps.ts`). It counts `blocked` tasks independently of
 * `resumableTaskCount` (which is `todo` + `in_progress` and excludes `blocked` entirely), and
 * discriminates the upstream-blocked subset (auto-clears once the prerequisite unblocks) from
 * own-blocked (needs the operator to actually fix something) via `isUpstreamBlocked`.
 */

import { describe, expect, it } from 'vitest';
import { computeTaskHealthCounts } from '@src/application/ui/shared/state-snapshot.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { BlockedTask, Task } from '@src/domain/entity/task.ts';
import { makeDoneTask, makeInProgressTaskWithRunningAttempt, makeTodoTask } from '@tests/fixtures/domain.ts';

const blockedTask = (blockKind: 'own' | 'upstream'): BlockedTask => {
  const r = markTaskBlocked(makeTodoTask(), 'stuck', blockKind);
  if (!r.ok) throw new Error(`fixture setup failed: ${r.error.message}`);
  return r.value;
};

describe('computeTaskHealthCounts', () => {
  it('returns zero counts for an empty task list', () => {
    expect(computeTaskHealthCounts([])).toEqual({ blockedTaskCount: 0, upstreamBlockedTaskCount: 0 });
  });

  it('ignores todo / in_progress / done tasks entirely — only blocked counts', () => {
    const tasks = [makeTodoTask(), makeInProgressTaskWithRunningAttempt(), makeDoneTask()];
    expect(computeTaskHealthCounts(tasks)).toEqual({ blockedTaskCount: 0, upstreamBlockedTaskCount: 0 });
  });

  it('counts every blocked task regardless of blockKind', () => {
    const tasks = [blockedTask('own'), blockedTask('upstream'), blockedTask('own'), makeTodoTask()];
    expect(computeTaskHealthCounts(tasks).blockedTaskCount).toBe(3);
  });

  it('discriminates the upstream-blocked subset from own-blocked', () => {
    const tasks = [blockedTask('own'), blockedTask('upstream'), blockedTask('upstream')];
    const { blockedTaskCount, upstreamBlockedTaskCount } = computeTaskHealthCounts(tasks);
    expect(blockedTaskCount).toBe(3);
    expect(upstreamBlockedTaskCount).toBe(2);
    // The "own"-blocked remainder — the subset that actually needs a fix.
    expect(blockedTaskCount - upstreamBlockedTaskCount).toBe(1);
  });

  it('an all-upstream sprint reports blockedTaskCount === upstreamBlockedTaskCount', () => {
    const tasks = [blockedTask('upstream'), blockedTask('upstream')];
    const { blockedTaskCount, upstreamBlockedTaskCount } = computeTaskHealthCounts(tasks);
    expect(upstreamBlockedTaskCount).toBe(blockedTaskCount);
  });

  it('the exact regression shape: 0 resumable + N blocked is NOT reported as zero', () => {
    // This is the bug this fixes: a sprint whose entire remainder is blocked used to read
    // "0 tasks pending" everywhere, because every consumer counted only todo/in_progress.
    const tasks: readonly Task[] = [blockedTask('own'), blockedTask('own')];
    const resumableTaskCount = tasks.filter((t) => t.status === 'todo' || t.status === 'in_progress').length;
    expect(resumableTaskCount).toBe(0);
    expect(computeTaskHealthCounts(tasks).blockedTaskCount).toBe(2);
  });
});
