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
import { ErrorCode } from '@src/domain/value/error/error-code.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Element } from '@src/application/chain/element.ts';
import { absolutePath, FIXED_LATER, makeBlockedTask, makeReviewSprint, makeTodoTask } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { recordingAppendFile } from '@tests/fixtures/recording-append-file.ts';
import { createReviewFlow, type CreateReviewFlowOpts } from '@src/application/flows/review/flow.ts';
import type { ReviewCtx } from '@src/application/flows/review/ctx.ts';
import type { ReviewDeps } from '@src/application/flows/review/deps.ts';
import { inMemorySprintRepo } from '@tests/fixtures/in-memory-repos.ts';
import { scriptedConfirm } from '@tests/fixtures/scripted-confirm.ts';

const findElement = <TCtx>(el: Element<TCtx>, target: string): Element<TCtx> | undefined => {
  if (el.name === target) return el;
  for (const child of el.children ?? []) {
    const hit = findElement(child, target);
    if (hit !== undefined) return hit;
  }
  return undefined;
};

const staticTaskRepo = (tasks: readonly Task[]): TaskRepository =>
  ({
    findBySprintId: async () => Result.ok(tasks),
  }) as unknown as TaskRepository;

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
    const interactive = scriptedConfirm([]);
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
    expect(interactive.messages).toEqual([]);
    expect(result.value.ctx.sprint?.status).toBe('done');
    expect(sprintRepo.current().status).toBe('done');
  });

  it('asks once and, on confirm, proceeds to close', async () => {
    const sprint = makeReviewSprint();
    const sprintRepo = inMemorySprintRepo(sprint);
    const append = recordingAppendFile();
    const interactive = scriptedConfirm([Result.ok(true)]);
    const tasks = [makeBlockedTask({ name: 'fix-the-thing' }), makeTodoTask({ name: 'unrelated-and-not-blocked' })];

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
    expect(interactive.messages).toHaveLength(1);
    expect(sprintRepo.current().status).toBe('done');
    // The outcome is recorded — the closing transition is journalled, same as close-sprint's.
    expect(append.snapshot()).toHaveLength(1);
  });

  it('declining the confirm aborts the close and leaves the sprint in review, re-runnable', async () => {
    const sprint = makeReviewSprint();
    const sprintRepo = inMemorySprintRepo(sprint);
    const append = recordingAppendFile();
    const interactive = scriptedConfirm([Result.ok(false)]);
    const tasks = [makeBlockedTask({ name: 'fix-the-thing' })];

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
    const interactive = scriptedConfirm([]);

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
