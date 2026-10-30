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
import { ErrorCode } from '@src/domain/value/error/error-code.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { FindTasksBySprintId } from '@src/domain/repository/task/find-tasks-by-sprint-id.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { absolutePath, FIXED_LATER, makeBlockedTask, makeReviewSprint, makeTodoTask } from '@tests/fixtures/domain.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { recordingAppendFile } from '@tests/fixtures/recording-append-file.ts';
import { createCloseSprintFlow } from '@src/application/flows/close-sprint/flow.ts';
import type { CloseSprintCtx } from '@src/application/flows/close-sprint/ctx.ts';
import type { CloseSprintDeps } from '@src/application/flows/close-sprint/deps.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import { unlockedSprintLockDeps } from '@tests/fixtures/pass-through-locker.ts';
import { inMemorySprintRepo } from '@tests/fixtures/in-memory-repos.ts';
import { scriptedConfirm } from '@tests/fixtures/scripted-confirm.ts';

const staticTaskRepo = (tasks: readonly Task[]): FindTasksBySprintId => ({
  findBySprintId: async () => Result.ok(tasks),
});

const baseDeps = (
  sprintRepo: SprintRepository,
  append: ReturnType<typeof recordingAppendFile>
): Omit<CloseSprintDeps, 'blockedTasksGate'> => ({
  ...unlockedSprintLockDeps(),
  sprintRepo,
  clock: () => FIXED_LATER,
  logger: noopLogger,
  appendFile: append.fn,
  writeFile: createAtomicWriteFile(),
  progressFile: absolutePath('/tmp/progress.md'),
});

describe('createCloseSprintFlow — blocked-task gate', () => {
  it('skips the confirm and closes normally when no task is blocked', async () => {
    const sprint = makeReviewSprint();
    const sprintRepo = inMemorySprintRepo(sprint);
    const append = recordingAppendFile();
    const interactive = scriptedConfirm([]);

    const flow = createCloseSprintFlow({
      ...unlockedSprintLockDeps(),
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
    expect(interactive.messages).toEqual([]);
    expect(sprintRepo.current().status).toBe('done');
  });

  it('asks once and, on confirm, proceeds to close', async () => {
    const sprint = makeReviewSprint();
    const sprintRepo = inMemorySprintRepo(sprint);
    const append = recordingAppendFile();
    const interactive = scriptedConfirm([Result.ok(true)]);
    const tasks = [makeBlockedTask({ name: 'fix-the-thing' }), makeTodoTask({ name: 'unrelated-and-not-blocked' })];

    const flow = createCloseSprintFlow({
      ...unlockedSprintLockDeps(),
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
    expect(interactive.messages).toHaveLength(1);
    expect(sprintRepo.current().status).toBe('done');
  });

  it('declining the confirm aborts the close and leaves the sprint in review, re-runnable', async () => {
    const sprint = makeReviewSprint();
    const sprintRepo = inMemorySprintRepo(sprint);
    const append = recordingAppendFile();
    const interactive = scriptedConfirm([Result.ok(false)]);
    const tasks = [makeBlockedTask({ name: 'fix-the-thing' })];

    const flow = createCloseSprintFlow({
      ...unlockedSprintLockDeps(),
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
