/**
 * Behavioural coverage for the review flow's blocked-task gate: `load-tasks` +
 * `guard(has-blocked-task, confirm-blocked-tasks)`, spliced into `review-settle` ahead of
 * `transition-sprint-to-done` — the SAME composition `createCloseSprintFlow` runs before its own
 * transition (`confirmBlockedTasksLeaf` from `_shared/task/confirm-blocked-tasks.ts`, generic over
 * any ctx carrying `tasks`). Review's auto-done path (empty / repeat feedback round) is the OTHER
 * door to `done`, so a sprint's blocked tasks must not close in silence through it either.
 *
 * Product decision under test: closing a sprint with blocked tasks is a CONFIRM, never a refusal
 * — matching close-sprint's own gate and its test suite exactly.
 *
 * Walks the REAL element tree `createReviewFlow` builds (never a hand-assembled stand-in chain)
 * and executes the `review-settle` sub-node directly — mirroring the `settle-attempt` wiring
 * pattern in `implement/flow-shape.test.ts` — so these tests prove `deps.taskRepo` /
 * `deps.interactive` reach the actual leaf instances the factory wires, not merely that the
 * leaves behave correctly when handed a double directly. The surrounding `review-loop` (AI-driven)
 * is out of scope here; `flow-shape.test.ts` already fences the full topology.
 */
import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { ErrorCode } from '@src/domain/value/error/error-code.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { AskConfirmInput, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Element } from '@src/application/chain/element.ts';
import { absolutePath, FIXED_LATER, makeReviewSprint, makeTodoTask } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { recordingAppendFile } from '@tests/fixtures/recording-append-file.ts';
import { createReviewFlow, type CreateReviewFlowOpts } from '@src/application/flows/review/flow.ts';
import type { ReviewCtx } from '@src/application/flows/review/ctx.ts';
import type { ReviewDeps } from '@src/application/flows/review/deps.ts';

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

const findElement = <TCtx>(el: Element<TCtx>, target: string): Element<TCtx> | undefined => {
  if (el.name === target) return el;
  for (const child of el.children ?? []) {
    const hit = findElement(child, target);
    if (hit !== undefined) return hit;
  }
  return undefined;
};

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

const staticTaskRepo = (tasks: readonly Task[]): TaskRepository =>
  ({
    findBySprintId: async () => Result.ok(tasks),
  }) as unknown as TaskRepository;

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

/**
 * Builds the REAL `createReviewFlow` tree, then locates `review-settle` — the sequential body
 * `review-settled` guards on `ctx.lastReviewExit`. Executing it directly skips the round loop
 * (out of scope) while still proving the construction site's own wiring.
 */
const buildSettleNode = (opts: {
  readonly sprintRepo: SprintRepository;
  readonly tasks: readonly Task[];
  readonly interactive: InteractivePrompt;
  readonly appendFile: ReturnType<typeof recordingAppendFile>['fn'];
  readonly sprintId: SprintId;
  readonly progressFile?: AbsolutePath;
}): Element<ReviewCtx> => {
  const deps = {
    sprintRepo: opts.sprintRepo,
    taskRepo: staticTaskRepo(opts.tasks),
    interactive: opts.interactive,
    clock: () => FIXED_LATER,
    logger: noopLogger,
    appendFile: opts.appendFile,
  } as unknown as ReviewDeps;
  const flowOpts: CreateReviewFlowOpts = {
    sprintId: opts.sprintId,
    sprintDir: absolutePath('/sprints/s1'),
    reviewRoot: absolutePath('/sprints/s1/review'),
    commitCwd: absolutePath('/repos/main'),
    additionalRoots: [absolutePath('/repos/main')],
    repositoriesBlock: '- main-repo',
    feedbackFile: absolutePath('/sprints/s1/feedback.md'),
    ...(opts.progressFile !== undefined ? { progressFile: opts.progressFile } : {}),
  };
  const tree = createReviewFlow(deps, flowOpts);
  const settleNode = findElement(tree, 'review-settle');
  if (settleNode === undefined) throw new Error('review-settle node not found in the constructed tree');
  return settleNode;
};

describe('createReviewFlow — review-settle blocked-task gate', () => {
  it('skips the confirm and transitions to done when no task is blocked', async () => {
    const sprint = makeReviewSprint();
    const sprintRepo = inMemorySprintRepo(sprint);
    const append = recordingAppendFile();
    const interactive = scriptedInteractive([]);
    const progressFile = absolutePath('/tmp/progress.md');

    const settleNode = buildSettleNode({
      sprintRepo: sprintRepo.repo,
      tasks: [makeTodoTask({ name: 'still-open' })],
      interactive: interactive.prompt,
      appendFile: append.fn,
      sprintId: sprint.id,
      progressFile,
    });

    const ctx: ReviewCtx = { sprintId: sprint.id, sprint, distillRequested: false };
    const result = await settleNode.execute(ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.trace.map((t) => t.elementName)).toEqual([
      'load-tasks',
      'confirm-blocked-tasks',
      'transition-sprint-to-done',
      'progress-journal-close',
    ]);
    expect(result.value.trace.find((t) => t.elementName === 'confirm-blocked-tasks')?.status).toBe('skipped');
    // The gate never asked anything — no blocked task, nothing to name.
    expect(interactive.messages()).toEqual([]);
    expect(result.value.ctx.sprint?.status).toBe('done');
    expect(sprintRepo.current().status).toBe('done');
  });

  it('names the blocked task(s) and, on confirm, proceeds to close', async () => {
    const sprint = makeReviewSprint();
    const sprintRepo = inMemorySprintRepo(sprint);
    const append = recordingAppendFile();
    const interactive = scriptedInteractive([Result.ok(true)]);
    const tasks = [blockedTask('fix-the-thing'), makeTodoTask({ name: 'unrelated-and-not-blocked' })];

    const settleNode = buildSettleNode({
      sprintRepo: sprintRepo.repo,
      tasks,
      interactive: interactive.prompt,
      appendFile: append.fn,
      sprintId: sprint.id,
      progressFile: absolutePath('/tmp/progress.md'),
    });

    const ctx: ReviewCtx = { sprintId: sprint.id, sprint, distillRequested: false };
    const result = await settleNode.execute(ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.trace.map((t) => t.elementName)).toEqual([
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
    // The outcome is recorded — the closing transition is journalled, same as close-sprint's.
    expect(append.snapshot()).toHaveLength(1);
  });

  it('declining the confirm aborts the close and leaves the sprint in review, re-runnable', async () => {
    const sprint = makeReviewSprint();
    const sprintRepo = inMemorySprintRepo(sprint);
    const append = recordingAppendFile();
    const interactive = scriptedInteractive([Result.ok(false)]);
    const tasks = [blockedTask('fix-the-thing')];

    const settleNode = buildSettleNode({
      sprintRepo: sprintRepo.repo,
      tasks,
      interactive: interactive.prompt,
      appendFile: append.fn,
      sprintId: sprint.id,
      progressFile: absolutePath('/tmp/progress.md'),
    });

    const ctx: ReviewCtx = { sprintId: sprint.id, sprint, distillRequested: false };
    const result = await settleNode.execute(ctx);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.trace.map((t) => t.elementName)).toEqual([
      'load-tasks',
      'confirm-blocked-tasks',
      'transition-sprint-to-done',
      'progress-journal-close',
    ]);
    expect(result.error.trace.find((t) => t.elementName === 'transition-sprint-to-done')?.status).toBe('skipped');
    expect(result.error.trace.find((t) => t.elementName === 'progress-journal-close')?.status).toBe('skipped');
    const confirmEntry = result.error.trace.find((t) => t.elementName === 'confirm-blocked-tasks');
    expect(confirmEntry?.error?.code).toBe(ErrorCode.Aborted);
    // Sprint never transitioned — stays `review`, so re-running review (e.g. after unblocking)
    // can still reach this decision point again.
    expect(sprintRepo.current().status).toBe('review');
    // Nothing was journaled — the blocked work was never silently closed over.
    expect(append.snapshot()).toEqual([]);
  });

  it('omits the append-journal-separator leaf entirely when no progressFile was resolved', async () => {
    const sprint = makeReviewSprint();
    const sprintRepo = inMemorySprintRepo(sprint);
    const append = recordingAppendFile();
    const interactive = scriptedInteractive([]);

    const settleNode = buildSettleNode({
      sprintRepo: sprintRepo.repo,
      tasks: [],
      interactive: interactive.prompt,
      appendFile: append.fn,
      sprintId: sprint.id,
      // progressFile omitted
    });

    const ctx: ReviewCtx = { sprintId: sprint.id, sprint, distillRequested: false };
    const result = await settleNode.execute(ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.trace.map((t) => t.elementName)).toEqual([
      'load-tasks',
      'confirm-blocked-tasks',
      'transition-sprint-to-done',
    ]);
    expect(append.snapshot()).toEqual([]);
  });
});
