/** `launchCloseSprint`'s pre-flight confirm explains, only when tasks are blocked, that they do not block the close. */
import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { AskConfirmInput, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { launchCloseSprint } from '@src/application/ui/shared/launch/close-sprint.ts';
import type { LaunchContext } from '@src/application/ui/shared/launch/context.ts';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import { makeReviewSprint, makeTodoTask } from '@tests/fixtures/domain.ts';

const unwrap = <T, E>(r: Result<T, E>): T => {
  if (!r.ok) {
    const err: unknown = r.error;
    const msg = err instanceof Error ? err.message : JSON.stringify(err);
    throw new Error(`fixture unwrap failed: ${msg}`);
  }
  return r.value as T;
};

const blockedTask = (name: string): Task =>
  unwrap(markTaskBlocked(makeTodoTask({ name }), 'ran out of attempts', 'own'));

const notStubbed = (method: string) => async (): Promise<never> => {
  throw new Error(`${method} not stubbed on this fake`);
};

/**
 * Records the FIRST `askConfirm` message, then aborts — `launchCloseSprint` returns
 * `{ ok: false, reason: 'Cancelled.' }` immediately after, before touching anything past the
 * pre-flight confirm, so every other `LaunchContext` dependency can stay uninitialised.
 */
const recordFirstMessageThenAbort = (messages: string[]): InteractivePrompt => ({
  askConfirm: async (input: AskConfirmInput): Promise<Result<boolean, DomainError>> => {
    messages.push(input.message);
    return Result.error(new AbortError({ elementName: 'test-abort', reason: 'stop after recording' }));
  },
  askText: notStubbed('askText'),
  askTextArea: notStubbed('askTextArea'),
  askChoice: notStubbed('askChoice'),
  askMultiChoice: notStubbed('askMultiChoice'),
});

const buildCtx = (interactive: InteractivePrompt, tasks: readonly Task[]): LaunchContext => {
  const snapshot: AppStateSnapshot = {
    sprint: makeReviewSprint(),
    tasks,
    triggerInputs: {
      hasProject: false,
      pendingTicketCount: 0,
      approvedTicketCount: 0,
      resumableTaskCount: 0,
    },
    projectCount: 0,
    sprintCount: 1,
    recentSprints: [],
  };
  return {
    deps: {
      interactive,
      storage: {} as never,
      app: {} as never,
      runInTerminal: async (fn: () => unknown) => fn(),
    },
    snapshot,
    extras: {},
    settings: {} as never,
    provider: {} as never,
    interactiveAi: {} as never,
    skillsAdapter: {} as never,
    skillSource: {} as never,
    cwd: undefined,
    sessionId: () => 'test-session',
    bridge: <T>(r: T): T => r,
  } as unknown as LaunchContext;
};

const BLOCKED_HINT = 'Blocked tasks are named in the close confirmation instead of blocking the close.';

describe('launchCloseSprint — blocked-task hint', () => {
  it('names the blocked count and appends the hint when a task is blocked', async () => {
    const messages: string[] = [];
    const ctx = buildCtx(recordFirstMessageThenAbort(messages), [blockedTask('fix-the-thing')]);

    await launchCloseSprint(ctx);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('1 blocked');
    expect(messages[0]).toContain(BLOCKED_HINT);
  });

  it('omits the hint when no task is blocked', async () => {
    const messages: string[] = [];
    const ctx = buildCtx(recordFirstMessageThenAbort(messages), [makeTodoTask({ name: 'still-open' })]);

    await launchCloseSprint(ctx);

    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toContain(BLOCKED_HINT);
  });
});
