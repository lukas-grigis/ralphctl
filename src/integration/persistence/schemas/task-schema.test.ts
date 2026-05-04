import { describe, expect, it } from 'vitest';

import { Task } from '@src/domain/entities/task.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { TaskId } from '@src/domain/values/task-id.ts';
import { TicketId } from '@src/domain/values/ticket-id.ts';
import { fromTask, taskJsonSchema, toTask } from './task-schema.ts';

function makeTask(): Task {
  const r = Task.create({
    name: 'Implement login',
    description: 'A description',
    steps: ['analyze', 'implement', 'test'],
    verificationCriteria: ['tests pass'],
    order: 1,
    blockedBy: [],
    projectPath: AbsolutePath.trustString('/code/demo'),
  });
  if (!r.ok) throw r.error;
  return r.value;
}

describe('task-schema', () => {
  it('round-trips a freshly-created (todo) task', () => {
    const original = makeTask();
    const json = fromTask(original);
    const parsed = taskJsonSchema.safeParse(json);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const back = toTask(parsed.data);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.id).toBe(original.id);
    expect(back.value.name).toBe(original.name);
    expect(back.value.status).toBe('todo');
    expect(back.value.steps).toStrictEqual(['analyze', 'implement', 'test']);
  });

  it('round-trips an in-progress task', () => {
    const t = makeTask();
    const next = t.markInProgress();
    if (!next.ok) throw next.error;
    const back = toTask(taskJsonSchema.parse(fromTask(next.value)));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.status).toBe('in_progress');
  });

  it('round-trips a done task with verification + evaluation', () => {
    const todo = makeTask();
    const inProgress = todo.markInProgress();
    if (!inProgress.ok) throw inProgress.error;
    const done = inProgress.value.markDone();
    if (!done.ok) throw done.error;
    const verified = done.value.recordVerification('all green');
    const evaluated = verified.recordEvaluation({
      output: 'looks good',
      status: 'passed',
      file: '/data/eval.md',
    });
    const back = toTask(taskJsonSchema.parse(fromTask(evaluated)));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.status).toBe('done');
    expect(back.value.verified).toBe(true);
    expect(back.value.verificationOutput).toBe('all green');
    expect(back.value.evaluated).toBe(true);
    expect(back.value.evaluationOutput).toBe('looks good');
    expect(back.value.evaluationStatus).toBe('passed');
    expect(back.value.evaluationFile).toBe('/data/eval.md');
  });

  it('preserves blockedBy and ticketId', () => {
    const ticketId = TicketId.trustString('abcdef01');
    const dep = TaskId.trustString('deadbeef');
    const r = Task.create({
      name: 'Dependent',
      steps: [],
      verificationCriteria: [],
      order: 2,
      blockedBy: [dep],
      ticketId,
      projectPath: AbsolutePath.trustString('/code'),
    });
    if (!r.ok) throw r.error;
    const back = toTask(taskJsonSchema.parse(fromTask(r.value)));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.ticketId).toBe(ticketId);
    expect(back.value.blockedBy).toStrictEqual([dep]);
  });

  it('preserves extraDimensions when present', () => {
    const r = Task.create({
      name: 'Extra dim',
      steps: [],
      verificationCriteria: [],
      order: 3,
      blockedBy: [],
      projectPath: AbsolutePath.trustString('/code'),
      extraDimensions: ['Performance', 'Security'],
    });
    if (!r.ok) throw r.error;
    const back = toTask(taskJsonSchema.parse(fromTask(r.value)));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.extraDimensions).toStrictEqual(['Performance', 'Security']);
  });

  it('round-trips a task with a recorded commit SHA', () => {
    const t = makeTask();
    const inProgress = t.markInProgress();
    if (!inProgress.ok) throw inProgress.error;
    const done = inProgress.value.markDone();
    if (!done.ok) throw done.error;
    const committed = done.value.recordCommit('abc123def4567890');
    expect(committed.commitSha).toBe('abc123def4567890');
    const json = fromTask(committed);
    expect(json.commitSha).toBe('abc123def4567890');
    const back = toTask(taskJsonSchema.parse(json));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.commitSha).toBe('abc123def4567890');
    // Status, evaluation, and other fields survive the round-trip too.
    expect(back.value.status).toBe('done');
  });

  it('omits commitSha from serialised JSON when absent (forward compat)', () => {
    const t = makeTask();
    const json = fromTask(t);
    expect(Object.prototype.hasOwnProperty.call(json, 'commitSha')).toBe(false);
  });

  it('round-trips a blocked task with reason', () => {
    const t = makeTask();
    const blockedR = t.markBlocked('wrong branch');
    if (!blockedR.ok) throw blockedR.error;
    const json = fromTask(blockedR.value);
    expect(json.status).toBe('blocked');
    expect(json.blockedReason).toBe('wrong branch');
    const back = toTask(taskJsonSchema.parse(json));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.status).toBe('blocked');
    expect(back.value.blockedReason).toBe('wrong branch');
  });

  it('rejects malformed JSON missing required fields', () => {
    const r = taskJsonSchema.safeParse({ id: 'x', name: 'no steps' });
    expect(r.success).toBe(false);
  });

  it('rejects schema-level invalid order', () => {
    const r = taskJsonSchema.safeParse({
      id: 'abcdef01',
      name: 'bad',
      steps: [],
      verificationCriteria: [],
      status: 'todo',
      order: 0,
      blockedBy: [],
      projectPath: '/p',
      verified: false,
      evaluated: false,
    });
    expect(r.success).toBe(false);
  });
});
