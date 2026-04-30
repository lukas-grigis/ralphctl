import { describe, expect, it } from 'vitest';

import { AbsolutePath } from '../values/absolute-path.ts';
import { TaskId } from '../values/task-id.ts';
import { TicketId } from '../values/ticket-id.ts';
import { Task } from './task.ts';

function path(p: string): AbsolutePath {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function taskId(s: string): TaskId {
  const r = TaskId.parse(s);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function freshTask(opts: Partial<Parameters<typeof Task.create>[0]> = {}): Task {
  const r = Task.create({
    name: 'Implement X',
    steps: ['step 1'],
    verificationCriteria: ['runs'],
    order: 1,
    projectPath: path('/abs/repo'),
    ...opts,
  });
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

describe('Task.create', () => {
  it('builds a todo task with sane defaults', () => {
    const t = freshTask();
    expect(t.status).toBe('todo');
    expect(t.verified).toBe(false);
    expect(t.evaluated).toBe(false);
    expect(t.blockedBy).toEqual([]);
    expect(t.id).toMatch(/^[0-9a-f]{8}$/);
    expect(t.steps).toEqual(['step 1']);
    expect(t.verificationCriteria).toEqual(['runs']);
    expect(t.extraDimensions).toBeUndefined();
  });

  it('uses an explicit id when provided', () => {
    const t = freshTask({ id: taskId('cafebabe') });
    expect(t.id).toBe('cafebabe');
  });

  it('trims the name and rejects empty after trim', () => {
    const ok = Task.create({
      name: '  hello  ',
      steps: [],
      verificationCriteria: [],
      order: 1,
      projectPath: path('/abs/r'),
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.name).toBe('hello');

    const bad = Task.create({
      name: '   ',
      steps: [],
      verificationCriteria: [],
      order: 1,
      projectPath: path('/abs/r'),
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.field).toBe('task.name');
  });

  it('rejects non-positive order', () => {
    const r = Task.create({
      name: 'x',
      steps: [],
      verificationCriteria: [],
      order: 0,
      projectPath: path('/abs/r'),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('task.order');
  });

  it('rejects fractional order', () => {
    const r = Task.create({
      name: 'x',
      steps: [],
      verificationCriteria: [],
      order: 1.5,
      projectPath: path('/abs/r'),
    });
    expect(r.ok).toBe(false);
  });

  it('preserves blockedBy and ticketId references', () => {
    const tid = TicketId.parse('deadbeef');
    if (!tid.ok) throw new Error('precondition failed');
    const t = freshTask({
      ticketId: tid.value,
      blockedBy: [taskId('aaaaaaaa'), taskId('bbbbbbbb')],
    });
    expect(t.ticketId).toBe('deadbeef');
    expect(t.blockedBy).toEqual(['aaaaaaaa', 'bbbbbbbb']);
  });

  it('preserves extraDimensions', () => {
    const t = freshTask({ extraDimensions: ['Performance', 'Security'] });
    expect(t.extraDimensions).toEqual(['Performance', 'Security']);
  });
});

describe('Task status transitions', () => {
  it('todo → in_progress', () => {
    const t = freshTask();
    const r = t.markInProgress();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.status).toBe('in_progress');
  });

  it('refuses todo → done', () => {
    const t = freshTask();
    const r = t.markDone();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid-state');
      expect(r.error.attemptedAction).toBe('mark-done');
    }
  });

  it('refuses in_progress → in_progress', () => {
    const t = freshTask();
    const r1 = t.markInProgress();
    if (!r1.ok) throw new Error('precondition failed');
    const r2 = r1.value.markInProgress();
    expect(r2.ok).toBe(false);
  });

  it('in_progress → done', () => {
    const t = freshTask();
    const r1 = t.markInProgress();
    if (!r1.ok) throw new Error('precondition failed');
    const r2 = r1.value.markDone();
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value.status).toBe('done');
  });

  it('refuses done → anything', () => {
    const t = freshTask();
    const r1 = t.markInProgress();
    if (!r1.ok) throw new Error('precondition failed');
    const r2 = r1.value.markDone();
    if (!r2.ok) throw new Error('precondition failed');
    expect(r2.value.markInProgress().ok).toBe(false);
    expect(r2.value.markDone().ok).toBe(false);
  });

  it('does not mutate the original on transition', () => {
    const t = freshTask();
    t.markInProgress();
    expect(t.status).toBe('todo');
  });
});

describe('Task.markBlocked', () => {
  it('blocks a todo task with a reason', () => {
    const t = freshTask();
    const r = t.markBlocked('wrong branch');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('blocked');
    expect(r.value.blockedReason).toBe('wrong branch');
  });

  it('blocks an in_progress task with a reason', () => {
    const ipR = freshTask().markInProgress();
    if (!ipR.ok) throw new Error('precondition failed');
    const r = ipR.value.markBlocked('external dep down');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('blocked');
    expect(r.value.blockedReason).toBe('external dep down');
  });

  it('refuses to block a done task', () => {
    const t = freshTask();
    const ipR = t.markInProgress();
    if (!ipR.ok) throw new Error('precondition failed');
    const doneR = ipR.value.markDone();
    if (!doneR.ok) throw new Error('precondition failed');
    const r = doneR.value.markBlocked('too late');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid-state');
      expect(r.error.attemptedAction).toBe('mark-blocked');
    }
  });

  it('refuses to re-block a blocked task', () => {
    const t = freshTask();
    const r1 = t.markBlocked('first');
    if (!r1.ok) throw new Error('precondition failed');
    const r2 = r1.value.markBlocked('second');
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe('invalid-state');
  });

  it('does not mutate the original on transition', () => {
    const t = freshTask();
    t.markBlocked('reason');
    expect(t.status).toBe('todo');
    expect(t.blockedReason).toBeUndefined();
  });
});

describe('Task.unblock', () => {
  it('unblocks a blocked task back to todo and clears reason', () => {
    const blockedR = freshTask().markBlocked('temp');
    if (!blockedR.ok) throw new Error('precondition failed');
    const r = blockedR.value.unblock();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('todo');
    expect(r.value.blockedReason).toBeUndefined();
  });

  it('refuses to unblock a non-blocked task', () => {
    const t = freshTask();
    const r = t.unblock();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid-state');
      expect(r.error.attemptedAction).toBe('unblock');
    }
  });

  it('after unblocking, the task can move forward through the lifecycle again', () => {
    const blockedR = freshTask().markBlocked('temp');
    if (!blockedR.ok) throw new Error('precondition failed');
    const unblockedR = blockedR.value.unblock();
    if (!unblockedR.ok) throw new Error('precondition failed');
    const ipR = unblockedR.value.markInProgress();
    expect(ipR.ok).toBe(true);
    if (!ipR.ok) return;
    expect(ipR.value.status).toBe('in_progress');
  });
});

describe('Task.recordVerification', () => {
  it('sets verified + output regardless of status', () => {
    const todo = freshTask();
    const v = todo.recordVerification('all green');
    expect(v.verified).toBe(true);
    expect(v.verificationOutput).toBe('all green');
    expect(v.status).toBe('todo');

    const ipR = freshTask().markInProgress();
    if (!ipR.ok) throw new Error('precondition failed');
    const v2 = ipR.value.recordVerification('passed');
    expect(v2.verified).toBe(true);
  });

  it('does not mutate the original', () => {
    const t = freshTask();
    t.recordVerification('x');
    expect(t.verified).toBe(false);
    expect(t.verificationOutput).toBeUndefined();
  });
});

describe('Task.recordEvaluation', () => {
  it('sets evaluated, status, file, and output', () => {
    const t = freshTask().recordEvaluation({
      output: 'critique preview',
      status: 'passed',
      file: '/sprint/evaluations/abc.md',
    });
    expect(t.evaluated).toBe(true);
    expect(t.evaluationStatus).toBe('passed');
    expect(t.evaluationFile).toBe('/sprint/evaluations/abc.md');
    expect(t.evaluationOutput).toBe('critique preview');
  });

  it('overwrites a prior evaluation', () => {
    const t1 = freshTask().recordEvaluation({
      output: 'first',
      status: 'failed',
      file: '/p/a.md',
    });
    const t2 = t1.recordEvaluation({
      output: 'second',
      status: 'passed',
      file: '/p/b.md',
    });
    expect(t2.evaluationStatus).toBe('passed');
    expect(t2.evaluationOutput).toBe('second');
    expect(t2.evaluationFile).toBe('/p/b.md');
  });
});

describe('Task.setBlockedBy', () => {
  it('overwrites the dependency list', () => {
    const t1 = freshTask({ blockedBy: [taskId('aaaaaaaa')] });
    const t2 = t1.setBlockedBy([taskId('bbbbbbbb'), taskId('cccccccc')]);
    expect(t2.blockedBy).toEqual(['bbbbbbbb', 'cccccccc']);
    // immutability
    expect(t1.blockedBy).toEqual(['aaaaaaaa']);
  });

  it('clears with empty array', () => {
    const t1 = freshTask({ blockedBy: [taskId('aaaaaaaa')] });
    const t2 = t1.setBlockedBy([]);
    expect(t2.blockedBy).toEqual([]);
  });
});

describe('Task.update', () => {
  it('updates the name on a todo task', () => {
    const t = freshTask();
    const r = t.update({ name: 'New Name' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe('New Name');
  });

  it('trims the new name and rejects empty after trim', () => {
    const t = freshTask();
    const ok = t.update({ name: '  trimmed  ' });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.name).toBe('trimmed');

    const bad = t.update({ name: '   ' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('invalid-value');
  });

  it('updates description, steps, verificationCriteria, blockedBy, projectPath', () => {
    const t = freshTask();
    const r = t.update({
      description: 'desc',
      steps: ['s1', 's2'],
      verificationCriteria: ['vc1'],
      blockedBy: [taskId('aaaaaaaa')],
      projectPath: path('/abs/other'),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.description).toBe('desc');
    expect(r.value.steps).toEqual(['s1', 's2']);
    expect(r.value.verificationCriteria).toEqual(['vc1']);
    expect(r.value.blockedBy).toEqual(['aaaaaaaa']);
    expect(r.value.projectPath).toBe(path('/abs/other'));
  });

  it('clears description / extraDimensions when null is passed', () => {
    const t = freshTask({ description: 'old', extraDimensions: ['Performance'] });
    const r = t.update({ description: null, extraDimensions: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.description).toBeUndefined();
    expect(r.value.extraDimensions).toBeUndefined();
  });

  it('refuses to update a task that is in_progress', () => {
    const t = freshTask();
    const ip = t.markInProgress();
    if (!ip.ok) throw new Error('precondition failed');
    const r = ip.value.update({ name: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid-state');
  });

  it('refuses to update a done task', () => {
    const t = freshTask();
    const ip = t.markInProgress();
    if (!ip.ok) throw new Error('precondition failed');
    const done = ip.value.markDone();
    if (!done.ok) throw new Error('precondition failed');
    const r = done.value.update({ name: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid-state');
  });

  it('does not mutate the original', () => {
    const t1 = freshTask();
    t1.update({ name: 'mutated' });
    expect(t1.name).toBe('Implement X');
  });
});

describe('Task immutability snapshot', () => {
  it('preserves every field on the original after transitions', () => {
    const t0 = freshTask({ ticketId: TicketId.trustString('deadbeef') });
    const snapshot = {
      id: t0.id,
      name: t0.name,
      description: t0.description,
      steps: t0.steps,
      verificationCriteria: t0.verificationCriteria,
      status: t0.status,
      order: t0.order,
      ticketId: t0.ticketId,
      blockedBy: t0.blockedBy,
      projectPath: t0.projectPath,
      verified: t0.verified,
      verificationOutput: t0.verificationOutput,
      evaluated: t0.evaluated,
      evaluationOutput: t0.evaluationOutput,
      evaluationStatus: t0.evaluationStatus,
      evaluationFile: t0.evaluationFile,
      extraDimensions: t0.extraDimensions,
      blockedReason: t0.blockedReason,
    };
    const ip = t0.markInProgress();
    if (!ip.ok) throw new Error('precondition failed');
    ip.value.markDone();
    ip.value.recordVerification('x');
    ip.value.recordEvaluation({ output: 'y', status: 'passed', file: 'z' });
    ip.value.setBlockedBy([taskId('aaaaaaaa')]);
    t0.markBlocked('reason');

    // Snapshot of t0 unchanged after every operation downstream.
    expect(t0.id).toBe(snapshot.id);
    expect(t0.name).toBe(snapshot.name);
    expect(t0.description).toBe(snapshot.description);
    expect(t0.steps).toBe(snapshot.steps);
    expect(t0.verificationCriteria).toBe(snapshot.verificationCriteria);
    expect(t0.status).toBe(snapshot.status);
    expect(t0.order).toBe(snapshot.order);
    expect(t0.ticketId).toBe(snapshot.ticketId);
    expect(t0.blockedBy).toBe(snapshot.blockedBy);
    expect(t0.projectPath).toBe(snapshot.projectPath);
    expect(t0.verified).toBe(snapshot.verified);
    expect(t0.verificationOutput).toBe(snapshot.verificationOutput);
    expect(t0.evaluated).toBe(snapshot.evaluated);
    expect(t0.evaluationOutput).toBe(snapshot.evaluationOutput);
    expect(t0.evaluationStatus).toBe(snapshot.evaluationStatus);
    expect(t0.evaluationFile).toBe(snapshot.evaluationFile);
    expect(t0.extraDimensions).toBe(snapshot.extraDimensions);
    expect(t0.blockedReason).toBe(snapshot.blockedReason);
  });
});
