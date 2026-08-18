/**
 * Sprint-detail — the per-attempt `v to open` affordance inside an expanded task card.
 *
 * The `v` chord is TASK-scoped: it opens `latestRecordedEvaluation(task)`, which walks backwards
 * past a crashed / aborted final attempt that never reached the evaluator. Every attempt card
 * still shows its OWN `evaluation: <status> (<file>)` line — that data is per-attempt and true —
 * but only the attempt the chord actually resolves to may advertise the chord, otherwise the hint
 * names a file `v` will not open.
 *
 * The gating predicate is `attempt.n === latestRecordedEvaluation(task)?.attemptN`, NOT "is the
 * last attempt" — the fixture below (attempts 1 + 2 evaluated, attempt 3 aborted with no verdict)
 * is exactly the case where those two differ.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { SprintDetailView } from '@src/application/ui/tui/views/sprint-detail-view.tsx';
import type { ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { recordRunningAttemptEvaluation, startNextAttempt } from '@src/domain/entity/task-attempts.ts';
import { failCurrentAttempt } from '@src/domain/entity/task-settle.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTodoTask } from '@tests/fixtures/domain.ts';

const FIXED_SPRINT_ID = 'sprint-attempt-hint-fixture' as unknown as SprintId;
const HINT = 'v to open';

const at = (minute: number): IsoTimestamp => `2026-08-17T09:${String(minute).padStart(2, '0')}:00.000Z` as IsoTimestamp;

const unwrap = <T, E>(r: Result<T, E>): T => {
  if (!r.ok) {
    const err: unknown = r.error;
    throw new Error(`fixture: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
  }
  return r.value as T;
};

const makeSprint = (): Sprint =>
  ({
    id: FIXED_SPRINT_ID,
    slug: 'attempt-hint-sprint',
    name: 'Attempt Hint Sprint',
    projectId: 'proj-fixture' as never,
    status: 'planned',
    tickets: [
      {
        id: 'ticket-a',
        title: 'alpha card',
        status: 'approved',
        description: 'alpha description',
        requirements: 'requirements for alpha card',
      },
    ],
  }) as unknown as Sprint;

/** Attempt `n` with a recorded verdict at `rounds/<n>/evaluator/evaluation.md`, then failed. */
const evaluatedAttempt = (task: Task, n: number): Task => {
  const started = unwrap(startNextAttempt(task, at(n * 2), `session-${String(n)}`));
  const evaluated = unwrap(
    recordRunningAttemptEvaluation(started, { status: 'failed', file: `rounds/${String(n)}/evaluator/evaluation.md` })
  );
  return unwrap(failCurrentAttempt(evaluated, at(n * 2 + 1), 'failed'));
};

/** Three attempts: 1 + 2 recorded verdicts, 3 aborted before reaching the evaluator. */
const taskWithCrashedFinalAttempt = (name: string): Task => {
  const evaluatedTwice = evaluatedAttempt(evaluatedAttempt(makeTodoTask({ name }), 1), 2);
  const third = unwrap(startNextAttempt(evaluatedTwice, at(6), 'session-3'));
  return unwrap(failCurrentAttempt(third, at(7), 'aborted'));
};

const singleEvaluatedAttemptTask = (name: string): Task => evaluatedAttempt(makeTodoTask({ name }), 1);

const stubDeps = (sprint: Sprint, tasks: readonly Task[]): AppDeps =>
  ({
    sprintRepo: {
      async findById() {
        return Result.ok(sprint);
      },
    } as unknown as SprintRepository,
    taskRepo: {
      async findBySprintId() {
        return Result.ok([...tasks]);
      },
    } as unknown as TaskRepository,
    projectRepo: {} as never,
    sprintExecutionRepo: {} as never,
    settingsRepo: {} as never,
    logger: noopLogger,
  }) as unknown as AppDeps;

const initial: ViewEntry = { id: 'sprint-detail', props: { sprintId: FIXED_SPRINT_ID } };

/** Renders the view, moves the cursor onto the single task row, and expands it. */
const expandTask = async (task: Task): Promise<string> => {
  const { result } = renderView(<SprintDetailView />, { deps: stubDeps(makeSprint(), [task]), initial });
  await waitForViewReady(result, (f) => f.includes(task.name));

  // The cursor starts on the ticket row; one step down lands on the task, `o` expands it.
  result.stdin.write('j');
  await tick(40);
  result.stdin.write('o');
  await waitForPredicate(() => (result.lastFrame() ?? '').includes('Attempt history'));

  const frame = result.lastFrame() ?? '';
  result.unmount();
  return frame;
};

const hintedLines = (frame: string): readonly string[] => frame.split('\n').filter((l) => l.includes(HINT));

describe('SprintDetailView — attempt cards advertise `v` only where the chord resolves', () => {
  it('hints on the last EVALUATED attempt, not the crashed final one', async () => {
    const frame = await expandTask(taskWithCrashedFinalAttempt('wire the migration'));

    // Every attempt keeps its own evaluation line — only the chord hint is gated.
    expect(frame).toContain('rounds/1/evaluator/evaluation.md');
    expect(frame).toContain('rounds/2/evaluator/evaluation.md');

    const hinted = hintedLines(frame);
    expect(hinted).toHaveLength(1);
    expect(hinted[0]).toContain('rounds/2/evaluator/evaluation.md');
  });

  it('hints on the sole attempt of a single-attempt task', async () => {
    const frame = await expandTask(singleEvaluatedAttemptTask('single shot'));

    const hinted = hintedLines(frame);
    expect(hinted).toHaveLength(1);
    expect(hinted[0]).toContain('rounds/1/evaluator/evaluation.md');
  });
});
