import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import {
  type CrashResumeTarget,
  decideCrashResume,
  type RecordedGeneratorRound,
} from '@src/business/task/crash-resume.ts';
import { startAttemptUseCase } from '@src/business/task/start-attempt.ts';
import { failCurrentAttempt } from '@src/domain/entity/task-settle.ts';
import { startNextAttempt } from '@src/domain/entity/task-attempts.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { FIXED_LATER, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

const unwrap = <T, E>(r: Result<T, E>): T => {
  if (!r.ok) throw new Error(String(r.error));
  return r.value as T;
};

const TARGET: CrashResumeTarget = { provider: 'claude-code', model: 'claude-opus-4-8', cwd: '/repo' };
const round = (overrides: Partial<RecordedGeneratorRound> = {}): RecordedGeneratorRound => ({
  roundN: 3,
  attemptN: 1,
  sessionId: 'sess-live',
  provider: 'claude-code',
  model: 'claude-opus-4-8',
  cwd: '/repo',
  ...overrides,
});

describe('decideCrashResume', () => {
  const task = makeInProgressTaskWithRunningAttempt();

  it('resumes the interrupted attempt’s session when provider, model and cwd all match', () => {
    expect(decideCrashResume(task, 1, round(), TARGET)).toEqual({ kind: 'resume', sessionId: 'sess-live', roundN: 3 });
  });

  it.each([
    ['provider', { provider: 'openai-codex' }],
    ['model', { model: 'claude-sonnet-4-6' }],
    ['cwd', { cwd: '/elsewhere' }],
  ] as const)('starts cold when the %s changed', (_field, overrides) => {
    expect(decideCrashResume(task, 1, round(overrides), TARGET).kind).toBe('cold');
  });

  it('starts cold when the round predates the cwd being recorded', () => {
    const legacy: RecordedGeneratorRound = { ...round() };
    delete (legacy as { cwd?: string }).cwd;
    expect(decideCrashResume(task, 1, legacy, TARGET).kind).toBe('cold');
  });

  it('starts cold when nothing was recorded', () => {
    expect(decideCrashResume(task, 1, undefined, TARGET)).toEqual({
      kind: 'cold',
      reason: 'no generator session recorded',
    });
  });

  it('starts cold when the newest session belongs to an earlier, settled attempt', () => {
    const failed = unwrap(failCurrentAttempt(task, FIXED_LATER, 'failed'));
    const second = unwrap(startNextAttempt(failed, FIXED_LATER));
    expect(decideCrashResume(second, 2, round({ attemptN: 1 }), TARGET).kind).toBe('cold');
  });

  it('follows a resume that was itself interrupted before its first round back to the session it resumed', () => {
    const interrupted = unwrap(failCurrentAttempt(task, FIXED_LATER, 'aborted', { abortCause: 'harness-interrupted' }));
    const resumed = unwrap(
      startNextAttempt(interrupted, FIXED_LATER, 'sess-live', {
        fromAttemptN: 1,
        cause: 'harness-interrupted',
        abortedAt: FIXED_LATER,
      })
    );
    expect(decideCrashResume(resumed, 2, round({ attemptN: 1 }), TARGET).kind).toBe('resume');
  });
});

describe('startAttemptUseCase — crash resume seeding', () => {
  const SPRINT = 'sprint-x' as SprintId;
  const run = async (task: Task, recorded: RecordedGeneratorRound | undefined) => {
    const writes: Task[] = [];
    const result = await startAttemptUseCase({
      task,
      sprintId: SPRINT,
      taskRepo: {
        update: async (_s, t) => {
          writes.push(t);
          return Result.ok(undefined);
        },
        findById: async () => Result.ok(task),
      },
      clock: () => FIXED_LATER,
      logger: noopLogger,
      crashResume: { findLastGeneratorRound: () => Promise.resolve(recorded), target: TARGET },
    });
    return { result, writes };
  };

  it('opens the fresh attempt on the interrupted session when it matches', async () => {
    const { result, writes } = await run(makeInProgressTaskWithRunningAttempt(), round());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fresh = result.value.attempts.at(-1);
    expect(fresh?.status).toBe('running');
    expect(fresh?.sessionId).toBe('sess-live');
    expect(fresh?.recovering?.cause).toBe('harness-interrupted');
    expect(writes[0]?.attempts.at(-1)?.sessionId).toBe('sess-live');
  });

  it('opens the fresh attempt cold when the recorded session does not match', async () => {
    const { result } = await run(makeInProgressTaskWithRunningAttempt(), round({ model: 'other-model' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attempts.at(-1)?.sessionId).toBeUndefined();
  });

  it('never looks a session up for a task that was not interrupted', async () => {
    let looked = false;
    const failed = unwrap(failCurrentAttempt(makeInProgressTaskWithRunningAttempt(), FIXED_LATER, 'failed'));
    const result = await startAttemptUseCase({
      task: failed,
      sprintId: SPRINT,
      taskRepo: { update: async () => Result.ok(undefined), findById: async () => Result.ok(failed) },
      clock: () => FIXED_LATER,
      logger: noopLogger,
      crashResume: {
        findLastGeneratorRound: () => {
          looked = true;
          return Promise.resolve(round());
        },
        target: TARGET,
      },
    });
    expect(result.ok).toBe(true);
    expect(looked).toBe(false);
  });
});
