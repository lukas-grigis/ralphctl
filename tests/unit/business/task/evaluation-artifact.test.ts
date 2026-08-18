/**
 * `latestRecordedEvaluation` + `evaluationArtifactSprintPath` — the two pure steps between a
 * `tasks.json` row and the `evaluation.md` on disk. Both are on the HARD DEGRADE path: a legacy
 * or hostile row must resolve to "nothing to open", never to a thrown error or a path outside
 * the sprint workspace.
 */

import { describe, expect, it } from 'vitest';
import { evaluationArtifactSprintPath, latestRecordedEvaluation } from '@src/business/task/evaluation-artifact.ts';
import type { Attempt } from '@src/domain/entity/attempt.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { makeTodoTask } from '@tests/fixtures/domain.ts';

const attempt = (n: number, evaluation: Attempt['evaluation'], finishedAt: string | null = null): Attempt =>
  ({
    n,
    status: evaluation === undefined ? 'aborted' : 'verified',
    startedAt: '2026-08-17T09:00:00.000Z',
    finishedAt,
    ...(evaluation !== undefined ? { evaluation } : {}),
  }) as unknown as Attempt;

const withAttempts = (attempts: readonly Attempt[]): Task => ({ ...makeTodoTask({ name: 't', order: 1 }), attempts });

describe('latestRecordedEvaluation', () => {
  it('returns undefined for a task with no attempts', () => {
    expect(latestRecordedEvaluation(withAttempts([]))).toBeUndefined();
  });

  it('returns undefined when no attempt recorded an evaluation', () => {
    expect(latestRecordedEvaluation(withAttempts([attempt(1, undefined), attempt(2, undefined)]))).toBeUndefined();
  });

  it('prefers the last attempt when it carries a verdict', () => {
    const task = withAttempts([
      attempt(1, { status: 'failed', file: 'rounds/1/evaluator/evaluation.md' }),
      attempt(2, { status: 'passed', file: 'rounds/3/evaluator/evaluation.md' }, '2026-08-17T10:00:00.000Z'),
    ]);
    expect(latestRecordedEvaluation(task)).toEqual({
      attemptN: 2,
      status: 'passed',
      file: 'rounds/3/evaluator/evaluation.md',
      finishedAt: '2026-08-17T10:00:00.000Z',
    });
  });

  it('falls back to the most recent attempt that has one when the final attempt aborted', () => {
    const task = withAttempts([
      attempt(1, { status: 'failed', file: 'rounds/1/evaluator/evaluation.md' }),
      attempt(2, undefined),
    ]);
    expect(latestRecordedEvaluation(task)?.attemptN).toBe(1);
  });

  it('omits finishedAt while the attempt is still running', () => {
    const task = withAttempts([attempt(1, { status: 'failed', file: 'rounds/1/evaluator/evaluation.md' })]);
    expect(latestRecordedEvaluation(task)).not.toHaveProperty('finishedAt');
  });
});

describe('evaluationArtifactSprintPath', () => {
  it('joins the recorded path under the per-task workspace', () => {
    expect(evaluationArtifactSprintPath('task-1', 'rounds/2/evaluator/evaluation.md')).toBe(
      'implement/task-1/rounds/2/evaluator/evaluation.md'
    );
  });

  it('degrades to undefined for a legacy row with no recorded path', () => {
    expect(evaluationArtifactSprintPath('task-1', '')).toBeUndefined();
    expect(evaluationArtifactSprintPath('task-1', '   ')).toBeUndefined();
  });

  it('refuses an absolute path', () => {
    expect(evaluationArtifactSprintPath('task-1', '/etc/passwd')).toBeUndefined();
  });

  it('refuses a path that climbs out of the workspace', () => {
    expect(evaluationArtifactSprintPath('task-1', '../../etc/passwd')).toBeUndefined();
    expect(evaluationArtifactSprintPath('task-1', 'rounds/../../../etc/passwd')).toBeUndefined();
  });

  it('allows an interior `..` that stays inside the workspace', () => {
    expect(evaluationArtifactSprintPath('task-1', 'rounds/2/../3/evaluator/evaluation.md')).toBe(
      'implement/task-1/rounds/3/evaluator/evaluation.md'
    );
  });
});
