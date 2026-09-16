/**
 * The shared blocked-task gate's PROMPT COPY, pinned at the leaf both doors to `done` splice
 * (close-sprint's flow and review's auto-done settle).
 *
 * It used to read "will stay unreachable once this sprint is done", which this release made
 * false: `reopenDoneSprint` puts a closed sprint back to `review`, `ralphctl sprint reopen`
 * exposes it, and unblocking a task from a done sprint reopens it automatically. The CLI's own
 * confirm (`ui/cli/commands/sprint.ts`) has said the correct thing since the same commit; this
 * fences the TUI gate to the same story so the two can't drift apart again.
 *
 * The flow-level suites next door (close-sprint / review) cover the gate's BEHAVIOUR — when it
 * fires, and that declining aborts. This file is only about the sentence.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { AskConfirmInput, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import {
  confirmBlockedTasksLeaf,
  type ConfirmBlockedTasksCtx,
} from '@src/application/flows/_shared/task/confirm-blocked-tasks.ts';
import { makeTodoTask } from '@tests/fixtures/domain.ts';

const blockedTask = (name: string): Task => {
  const r = markTaskBlocked(makeTodoTask({ name }), 'ran out of attempts', 'own');
  if (!r.ok) throw new Error(`fixture setup failed: ${r.error.message}`);
  return r.value;
};

/** Records the message it was asked and always confirms, so the chain falls through. */
const recordingInteractive = (): { readonly prompt: InteractivePrompt; readonly messages: () => readonly string[] } => {
  const messages: string[] = [];
  const notStubbed = (method: string) => async (): Promise<never> => {
    throw new Error(`${method} not stubbed on this fake`);
  };
  const prompt: InteractivePrompt = {
    askText: notStubbed('askText'),
    askTextArea: notStubbed('askTextArea'),
    askChoice: notStubbed('askChoice'),
    askMultiChoice: notStubbed('askMultiChoice'),
    askConfirm: async (input: AskConfirmInput) => {
      messages.push(input.message);
      return Result.ok(true);
    },
  };
  return { prompt, messages: () => messages };
};

const askedMessage = async (tasks: readonly Task[]): Promise<string> => {
  const interactive = recordingInteractive();
  const leaf = confirmBlockedTasksLeaf<ConfirmBlockedTasksCtx>({ interactive: interactive.prompt });
  const out = await leaf.execute({ tasks });
  expect(out.ok).toBe(true);
  const [message] = interactive.messages();
  if (message === undefined) throw new Error('the gate never asked for confirmation');
  return message;
};

describe('confirmBlockedTasksLeaf — prompt copy', () => {
  it('describes the close as reversible, not as permanent loss', async () => {
    const message = await askedMessage([blockedTask('wire the migration')]);

    expect(message).toContain('1 task(s) are blocked');
    expect(message).toContain('reopened');
    expect(message).toContain('unblocking one reopens it');
    // The pre-release claim. `reopenDoneSprint` / `sprint reopen` / the automatic reopen inside
    // `unblockTaskUseCase` all falsify it, so it must never come back.
    expect(message).not.toContain('unreachable');
  });

  it('still names the blocked tasks and asks for a decision', async () => {
    const message = await askedMessage([blockedTask('wire the migration'), blockedTask('fix the codec')]);

    expect(message).toContain('2 task(s) are blocked');
    expect(message).toContain('wire the migration');
    expect(message).toContain('fix the codec');
    expect(message).toContain('Close anyway?');
  });
});
