/**
 * Behavioural coverage for the close-sprint flow's blocked-task gate: `load-tasks` +
 * `guard(has-blocked-task, confirm-blocked-tasks)`, spliced between `assert-sprint-status` and
 * `refresh-memory-mirror` / `transition-sprint-to-done` in `createCloseSprintFlow`.
 *
 * Product decision under test: closing a sprint with blocked tasks is a CONFIRM, never a
 * refusal. The gate only ever fires when at least one task is `blocked`; declining is treated
 * like a Ctrl+C at that step (an `AbortError`) so the sprint stays `review` and re-runnable,
 * mirroring the pre-flow confirm's own cancel semantics — matching the established
 * `preflight-task.ts` "cancel choice → AbortError" idiom elsewhere in this codebase.
 */
import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { ErrorCode } from '@src/domain/value/error/error-code.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { FindTasksBySprintId } from '@src/domain/repository/task/find-tasks-by-sprint-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { AskConfirmInput, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { absolutePath, FIXED_LATER, makeReviewSprint, makeTodoTask } from '@tests/fixtures/domain.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { recordingAppendFile } from '@tests/fixtures/recording-append-file.ts';
import { createCloseSprintFlow } from '@src/application/flows/close-sprint/flow.ts';
import type { CloseSprintCtx } from '@src/application/flows/close-sprint/ctx.ts';
import type { CloseSprintDeps } from '@src/application/flows/close-sprint/deps.ts';

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

const inMemorySprintRepo = (initial: Sprint): { readonly repo: SprintRepository; readonly current: () => Sprint } => {
  let current = initial;
  const repo: SprintRepository = {
    async findById(id: SprintId) {
      if (current.id === id) return Result.ok(current);
      return Result.error(new NotFoundError({ entity: 'sprint', id: String(id) }));
    },
    async save(sprint: Sprint) {
      current = sprint;
      return Result.ok(undefined);
    },
  } as SprintRepository;
  return { repo, current: () => current };
};

const staticTaskRepo = (tasks: readonly Task[]): FindTasksBySprintId => ({
  findBySprintId: async () => Result.ok(tasks),
});

/** Scripted `askConfirm` fake — records every message it was asked, replays canned answers in order. */
const scriptedInteractive = (
  responses: ReadonlyArray<Result<boolean, DomainError>>
): { readonly prompt: InteractivePrompt; readonly messages: () => readonly string[] } => {
  const messages: string[] = [];
  let next = 0;
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
      const response = responses[next];
      next += 1;
      if (response === undefined) throw new Error('scriptedInteractive: no more scripted responses');
      return response;
    },
  };
  return { prompt, messages: () => messages };
};

const baseDeps = (
  sprintRepo: SprintRepository,
  append: ReturnType<typeof recordingAppendFile>
): Omit<CloseSprintDeps, 'blockedTasksGate'> => ({
  sprintRepo,
  clock: () => FIXED_LATER,
  logger: noopLogger,
  appendFile: append.fn,
  progressFile: absolutePath('/tmp/progress.md'),
});

describe('createCloseSprintFlow — blocked-task gate', () => {
  it('skips the confirm and closes normally when no task is blocked', async () => {
    const sprint = makeReviewSprint();
    const sprintRepo = inMemorySprintRepo(sprint);
    const append = recordingAppendFile();
    const interactive = scriptedInteractive([]);

    const flow = createCloseSprintFlow({
      ...baseDeps(sprintRepo.repo, append),
      blockedTasksGate: {
        taskRepo: staticTaskRepo([makeTodoTask({ name: 'still-open' })]),
        interactive: interactive.prompt,
      },
    });
    const runner = createRunner<CloseSprintCtx>({
      id: 'r-no-blocked',
      element: flow,
      initialCtx: { sprintId: sprint.id, distillRequested: false },
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(runner.trace.map((t) => t.elementName)).toEqual([
      'load-sprint',
      'assert-sprint-status',
      'load-tasks',
      'confirm-blocked-tasks',
      'transition-sprint-to-done',
      'progress-journal-close',
    ]);
    expect(runner.trace.find((t) => t.elementName === 'confirm-blocked-tasks')?.status).toBe('skipped');
    // The gate never asked anything — no blocked task, nothing to name.
    expect(interactive.messages()).toEqual([]);
    expect(sprintRepo.current().status).toBe('done');
  });

  it('names the blocked task(s) and, on confirm, proceeds to close', async () => {
    const sprint = makeReviewSprint();
    const sprintRepo = inMemorySprintRepo(sprint);
    const append = recordingAppendFile();
    const interactive = scriptedInteractive([Result.ok(true)]);
    const tasks = [blockedTask('fix-the-thing'), makeTodoTask({ name: 'unrelated-and-not-blocked' })];

    const flow = createCloseSprintFlow({
      ...baseDeps(sprintRepo.repo, append),
      blockedTasksGate: { taskRepo: staticTaskRepo(tasks), interactive: interactive.prompt },
    });
    const runner = createRunner<CloseSprintCtx>({
      id: 'r-confirmed',
      element: flow,
      initialCtx: { sprintId: sprint.id, distillRequested: false },
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(runner.trace.map((t) => t.elementName)).toEqual([
      'load-sprint',
      'assert-sprint-status',
      'load-tasks',
      'confirm-blocked-tasks',
      'transition-sprint-to-done',
      'progress-journal-close',
    ]);
    const [message] = interactive.messages();
    expect(message).toContain('1 task(s)');
    expect(message).toContain('fix-the-thing');
    expect(message).not.toContain('unrelated-and-not-blocked');
    expect(sprintRepo.current().status).toBe('done');
  });

  it('declining the confirm aborts the close and leaves the sprint in review, re-runnable', async () => {
    const sprint = makeReviewSprint();
    const sprintRepo = inMemorySprintRepo(sprint);
    const append = recordingAppendFile();
    const interactive = scriptedInteractive([Result.ok(false)]);
    const tasks = [blockedTask('fix-the-thing')];

    const flow = createCloseSprintFlow({
      ...baseDeps(sprintRepo.repo, append),
      blockedTasksGate: { taskRepo: staticTaskRepo(tasks), interactive: interactive.prompt },
    });
    const runner = createRunner<CloseSprintCtx>({
      id: 'r-declined',
      element: flow,
      initialCtx: { sprintId: sprint.id, distillRequested: false },
    });
    await runner.start();

    // Overall runner status reads `aborted` (the runner checks the propagated error's `.code`,
    // per `ErrorCode.Aborted`) regardless of the individual leaf's own trace-entry label —
    // mirrors how `preflightTaskLeaf`'s "cancel" choice is asserted elsewhere in this codebase.
    expect(runner.status).toBe('aborted');
    expect(runner.trace.map((t) => t.elementName)).toEqual([
      'load-sprint',
      'assert-sprint-status',
      'load-tasks',
      'confirm-blocked-tasks',
      'transition-sprint-to-done',
      'progress-journal-close',
    ]);
    // Neither the transition nor the journal separator ran.
    expect(runner.trace.find((t) => t.elementName === 'transition-sprint-to-done')?.status).toBe('skipped');
    expect(runner.trace.find((t) => t.elementName === 'progress-journal-close')?.status).toBe('skipped');
    const confirmEntry = runner.trace.find((t) => t.elementName === 'confirm-blocked-tasks');
    expect(confirmEntry?.error?.code).toBe(ErrorCode.Aborted);
    // Sprint never transitioned — stays `review`, so a retry (e.g. after unblocking) can re-run.
    expect(sprintRepo.current().status).toBe('review');
    // Nothing was journaled.
    expect(append.snapshot()).toEqual([]);
  });

  it('truncates a long blocked-task list sanely instead of naming every one', async () => {
    const sprint = makeReviewSprint();
    const sprintRepo = inMemorySprintRepo(sprint);
    const append = recordingAppendFile();
    const interactive = scriptedInteractive([Result.ok(true)]);
    const tasks = Array.from({ length: 8 }, (_unused, i) => blockedTask(`task-${String(i)}`));

    const flow = createCloseSprintFlow({
      ...baseDeps(sprintRepo.repo, append),
      blockedTasksGate: { taskRepo: staticTaskRepo(tasks), interactive: interactive.prompt },
    });
    const runner = createRunner<CloseSprintCtx>({
      id: 'r-truncated',
      element: flow,
      initialCtx: { sprintId: sprint.id, distillRequested: false },
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    const [message] = interactive.messages();
    expect(message).toContain('8 task(s)');
    for (let i = 0; i < 5; i += 1) expect(message).toContain(`task-${String(i)}`);
    expect(message).toContain('and 3 more');
    expect(message).not.toContain('task-5');
    expect(message).not.toContain('task-6');
    expect(message).not.toContain('task-7');
  });

  it('omits the confirm entirely when blockedTasksGate is not wired (matches the CLI close path)', async () => {
    const sprint = makeReviewSprint();
    const sprintRepo = inMemorySprintRepo(sprint);
    const append = recordingAppendFile();

    // No `blockedTasksGate` — mirrors `cli/commands/sprint.ts`'s `closeSprintAction`, which has
    // no `InteractivePrompt` implementation to route a confirm through. This is a deliberate,
    // pre-existing gap (see this task's `deps.ts` doc comment), not a regression: the CLI path
    // must keep compiling and behaving exactly as it did before this gate existed.
    const flow = createCloseSprintFlow(baseDeps(sprintRepo.repo, append));
    const runner = createRunner<CloseSprintCtx>({
      id: 'r-no-gate',
      element: flow,
      initialCtx: { sprintId: sprint.id, distillRequested: false },
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(runner.trace.map((t) => t.elementName)).toEqual([
      'load-sprint',
      'assert-sprint-status',
      'transition-sprint-to-done',
      'progress-journal-close',
    ]);
    expect(sprintRepo.current().status).toBe('done');
  });
});
