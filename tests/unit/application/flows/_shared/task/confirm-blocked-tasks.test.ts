/**
 * The shared blocked-task gate (`confirmBlockedTasksLeaf`) behind both doors to `done` — close-sprint
 * and review's auto-done settle. A confirm, never a refusal: confirming falls through, declining is an
 * `AbortError` so the chain stops before the transition. The flow suites next door only prove their
 * `deps` reach this leaf.
 */
import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { ErrorCode } from '@src/domain/value/error/error-code.ts';
import {
  confirmBlockedTasksLeaf,
  type ConfirmBlockedTasksCtx,
} from '@src/application/flows/_shared/task/confirm-blocked-tasks.ts';
import { makeBlockedTask, makeTodoTask } from '@tests/fixtures/domain.ts';
import { scriptedConfirm } from '@tests/fixtures/scripted-confirm.ts';

const run = async (tasks: readonly Task[], answer: Result<boolean, never> = Result.ok(true)) => {
  const interactive = scriptedConfirm([answer]);
  const leaf = confirmBlockedTasksLeaf<ConfirmBlockedTasksCtx>({ interactive: interactive.prompt });
  const out = await leaf.execute({ tasks });
  return { out, interactive };
};

const askedMessage = async (tasks: readonly Task[]): Promise<string> => {
  const { out, interactive } = await run(tasks);
  expect(out.ok).toBe(true);
  const [message] = interactive.messages;
  if (message === undefined) throw new Error('the gate never asked for confirmation');
  return message;
};

describe('confirmBlockedTasksLeaf', () => {
  it('names only the blocked tasks and falls through on confirm', async () => {
    const message = await askedMessage([
      makeBlockedTask({ name: 'fix-the-thing' }),
      makeTodoTask({ name: 'unrelated-and-not-blocked' }),
    ]);

    expect(message).toContain('1 task(s)');
    expect(message).toContain('fix-the-thing');
    expect(message).not.toContain('unrelated-and-not-blocked');
  });

  it('aborts on decline so the chain stops before the transition', async () => {
    const { out } = await run([makeBlockedTask({ name: 'fix-the-thing' })], Result.ok(false));

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.error.code).toBe(ErrorCode.Aborted);
  });

  it('truncates a long blocked-task list instead of naming every one', async () => {
    const tasks = Array.from({ length: 8 }, (_unused, i) => makeBlockedTask({ name: `task-${String(i)}` }));
    const message = await askedMessage(tasks);

    expect(message).toContain('8 task(s)');
    for (let i = 0; i < 5; i += 1) expect(message).toContain(`task-${String(i)}`);
    expect(message).toContain('and 3 more');
    for (const hidden of ['task-5', 'task-6', 'task-7']) expect(message).not.toContain(hidden);
  });

  it('describes the close as reversible, not as permanent loss', async () => {
    const message = await askedMessage([makeBlockedTask({ name: 'wire the migration' })]);

    expect(message).toContain('1 task(s) are blocked');
    expect(message).toContain('reopened');
    expect(message).toContain('unblocking one reopens it');
    // The old claim: `reopenDoneSprint` / `sprint reopen` / the automatic reopen on unblock falsify it.
    expect(message).not.toContain('unreachable');
  });

  it('names every blocked task and asks for a decision', async () => {
    const message = await askedMessage([
      makeBlockedTask({ name: 'wire the migration' }),
      makeBlockedTask({ name: 'fix the codec' }),
    ]);

    expect(message).toContain('2 task(s) are blocked');
    expect(message).toContain('wire the migration');
    expect(message).toContain('fix the codec');
    expect(message).toContain('Close anyway?');
  });
});
