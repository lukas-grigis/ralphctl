/**
 * `launchCloseSprint`'s pre-flight confirm reads its blocked-task threshold and explanatory hint
 * straight off `closeSprintManifest.triggers` (`maxBlockedTasks` / `maxBlockedTasksHint`) instead
 * of a hardcoded `blockedTaskCount > 0` literal — proves the trigger fields are load-bearing,
 * matching `FlowTriggers`'s own doc comment in `registry.ts` ("close-sprint's own launcher reads
 * it off this manifest"). Asserting against the REAL manifest's hint text (never a copy retyped
 * in this file) is what makes this a wiring test rather than a message-content test: it would
 * fail if the launcher stopped reading the manifest, and it would also fail (usefully) if the
 * manifest's hint text ever changed without the launcher noticing.
 */
import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { AskConfirmInput, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { launchCloseSprint } from '@src/application/ui/shared/launch/close-sprint.ts';
import { closeSprintManifest } from '@src/application/flows/close-sprint/manifest.ts';
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

describe('launchCloseSprint — blocked-task threshold reads the manifest, not a hardcoded literal', () => {
  it("appends the manifest's maxBlockedTasksHint when the blocked count exceeds maxBlockedTasks", async () => {
    const hint = closeSprintManifest.triggers.maxBlockedTasksHint;
    expect(hint).toBeDefined();
    if (hint === undefined) return;

    const messages: string[] = [];
    const ctx = buildCtx(recordFirstMessageThenAbort(messages), [blockedTask('fix-the-thing')]);

    await launchCloseSprint(ctx);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(hint);
  });

  it('omits the hint when the blocked count does not exceed the threshold (no blocked tasks)', async () => {
    const messages: string[] = [];
    const ctx = buildCtx(recordFirstMessageThenAbort(messages), [makeTodoTask({ name: 'still-open' })]);

    await launchCloseSprint(ctx);

    expect(messages).toHaveLength(1);
    const hint = closeSprintManifest.triggers.maxBlockedTasksHint;
    if (hint !== undefined) expect(messages[0]).not.toContain(hint);
  });
});
