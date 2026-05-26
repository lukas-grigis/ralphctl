import { describe, expect, it } from 'vitest';
import type { DoneTask, InProgressTask, VerificationCriterion } from '@src/domain/entity/task.ts';
import { createTask, updateTask } from '@src/domain/entity/task-factory.ts';
import {
  recordRunningAttemptCommit,
  recordRunningAttemptCritique,
  recordRunningAttemptEvaluation,
  recordRunningAttemptVerification,
  startNextAttempt,
} from '@src/domain/entity/task-attempts.ts';
import { failCurrentAttempt, markTaskDone } from '@src/domain/entity/task-settle.ts';
import { markTaskBlocked, resetTaskToTodo, unblockTask } from '@src/domain/entity/task-lifecycle.ts';
import {
  commitSha,
  FIXED_LATER,
  FIXED_NOW,
  FIXED_REPOSITORY_ID,
  makeApprovedTicket,
  makeDoneTask,
  makeInProgressTaskWithRunningAttempt,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';

describe('startNextAttempt', () => {
  it('todo → in_progress and appends a running attempt', () => {
    const todo = makeTodoTask();
    const r = startNextAttempt(todo, FIXED_NOW, 'session-1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('in_progress');
    expect(r.value.attempts).toHaveLength(1);
    expect(r.value.attempts[0]?.status).toBe('running');
    expect(r.value.attempts[0]?.n).toBe(1);
    expect(r.value.attempts[0]?.sessionId).toBe('session-1');
  });

  it('rejects when last attempt is still running', () => {
    const ip = makeInProgressTaskWithRunningAttempt();
    const r = startNextAttempt(ip, FIXED_LATER);
    expect(r.ok).toBe(false);
  });

  it('rejects from done', () => {
    const r = startNextAttempt(makeDoneTask(), FIXED_LATER);
    expect(r.ok).toBe(false);
  });
});

describe('record* on running attempt', () => {
  const seed = (): InProgressTask => makeInProgressTaskWithRunningAttempt();

  it('records the structural verification marker (no body)', () => {
    const r = recordRunningAttemptVerification(seed());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.attempts.at(-1)?.verification).toEqual({});
  });

  it('records evaluation', () => {
    const r = recordRunningAttemptEvaluation(seed(), {
      status: 'passed',
      file: 'rounds/1/evaluator/evaluation.md',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.attempts.at(-1)?.evaluation?.status).toBe('passed');
  });

  it('records critique non-empty', () => {
    const r = recordRunningAttemptCritique(seed(), 'add more tests');
    expect(r.ok).toBe(true);
    const empty = recordRunningAttemptCritique(seed(), '   ');
    expect(empty.ok).toBe(false);
  });

  it('records commit sha', () => {
    const r = recordRunningAttemptCommit(seed(), commitSha('a'.repeat(40)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.attempts.at(-1)?.commitSha).toBe('a'.repeat(40));
  });
});

describe('markTaskDone', () => {
  it('rejects when running attempt has no verification', () => {
    const r = markTaskDone(makeInProgressTaskWithRunningAttempt(), FIXED_LATER);
    expect(r.ok).toBe(false);
  });

  it('transitions in_progress → done with verified attempt', () => {
    const ip = makeInProgressTaskWithRunningAttempt();
    const verified = recordRunningAttemptVerification(ip);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    const r = markTaskDone(verified.value, FIXED_LATER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const done: DoneTask = r.value;
    expect(done.status).toBe('done');
    expect(done.finalAttemptN).toBe(1);
    expect(done.attempts.at(-1)?.status).toBe('verified');
  });
});

describe('failCurrentAttempt', () => {
  it('stays in_progress when budget remains', () => {
    const ip = makeInProgressTaskWithRunningAttempt({ maxAttempts: 3 });
    const r = failCurrentAttempt(ip, FIXED_LATER, 'failed');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('in_progress');
    expect(r.value.attempts.at(-1)?.status).toBe('failed');
  });

  it('transitions to blocked when budget exhausted', () => {
    const ip = makeInProgressTaskWithRunningAttempt({ maxAttempts: 1 });
    const r = failCurrentAttempt(ip, FIXED_LATER, 'failed');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('blocked');
    if (r.value.status !== 'blocked') return;
    expect(r.value.blockedReason).toContain('attempt budget exhausted');
  });

  it('rejects from todo', () => {
    const r = failCurrentAttempt(makeTodoTask(), FIXED_LATER, 'failed');
    expect(r.ok).toBe(false);
  });
});

describe('block / unblock / reset', () => {
  it('todo → blocked → todo', () => {
    const blocked = markTaskBlocked(makeTodoTask(), 'waiting on infra');
    expect(blocked.ok).toBe(true);
    if (!blocked.ok) return;
    const back = unblockTask(blocked.value);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.status).toBe('todo');
  });

  it('resetTaskToTodo rejects when running attempt is unsettled', () => {
    const r = resetTaskToTodo(makeInProgressTaskWithRunningAttempt());
    expect(r.ok).toBe(false);
  });

  it('resetTaskToTodo allows reset after attempt is settled', () => {
    const ip = makeInProgressTaskWithRunningAttempt();
    const failed = failCurrentAttempt(ip, FIXED_LATER, 'aborted');
    expect(failed.ok).toBe(true);
    if (!failed.ok || failed.value.status !== 'in_progress') return;
    const back = resetTaskToTodo(failed.value);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.status).toBe('todo');
  });
});

describe('updateTask', () => {
  it('only allowed on todo', () => {
    const ok = updateTask(makeTodoTask(), { name: 'renamed' });
    expect(ok.ok).toBe(true);
    const denied = updateTask(makeInProgressTaskWithRunningAttempt(), { name: 'nope' });
    expect(denied.ok).toBe(false);
  });

  it('clears optional fields with null', () => {
    const seed = makeTodoTask();
    const r = updateTask(seed, { description: null, extraDimensions: null, maxAttempts: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.description).toBeUndefined();
    expect(r.value.extraDimensions).toBeUndefined();
    expect(r.value.maxAttempts).toBeUndefined();
  });
});

describe('VerificationCriterion invariants', () => {
  const baseTaskInput = (criteria: readonly VerificationCriterion[]) => ({
    name: 'do-the-thing',
    steps: ['step 1'],
    verificationCriteria: criteria,
    order: 1,
    ticketId: makeApprovedTicket().id,
    repositoryId: FIXED_REPOSITORY_ID,
  });

  it('createTask accepts manual criteria without a command', () => {
    const r = createTask(baseTaskInput([{ id: 'C1', assertion: 'looks right', check: 'manual' }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.verificationCriteria[0]?.command).toBeUndefined();
  });

  it('createTask accepts auto criteria with a non-empty command', () => {
    const r = createTask(
      baseTaskInput([{ id: 'C1', assertion: 'TypeScript compiles', check: 'auto', command: 'npm run typecheck' }])
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.verificationCriteria[0]?.command).toBe('npm run typecheck');
  });

  it('createTask rejects auto criteria with no command', () => {
    const r = createTask(baseTaskInput([{ id: 'C1', assertion: 'X', check: 'auto' }]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/auto.*command/);
  });

  it('createTask rejects auto criteria with an empty / whitespace command', () => {
    const r = createTask(baseTaskInput([{ id: 'C1', assertion: 'X', check: 'auto', command: '   ' }]));
    expect(r.ok).toBe(false);
  });

  it('createTask rejects manual criteria that carry a command', () => {
    const r = createTask(
      baseTaskInput([{ id: 'C1', assertion: 'visual check', check: 'manual', command: 'npm test' }])
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/manual.*command/);
  });

  it('updateTask propagates the same invariant', () => {
    const todo = makeTodoTask();
    const denied = updateTask(todo, {
      verificationCriteria: [{ id: 'C1', assertion: 'X', check: 'auto' }],
    });
    expect(denied.ok).toBe(false);
    const ok = updateTask(todo, {
      verificationCriteria: [{ id: 'C1', assertion: 'X', check: 'auto', command: 'npm test' }],
    });
    expect(ok.ok).toBe(true);
  });

  it('updateTask drops the command field for manual criteria when cloning', () => {
    const todo = makeTodoTask();
    const r = updateTask(todo, {
      verificationCriteria: [{ id: 'C1', assertion: 'manual', check: 'manual' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.verificationCriteria[0]).toEqual({ id: 'C1', assertion: 'manual', check: 'manual' });
  });
});
