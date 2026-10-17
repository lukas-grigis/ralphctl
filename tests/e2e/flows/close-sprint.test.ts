import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { attachTicketLink, type DoneSprint, type Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import {
  absolutePath,
  FIXED_LATER,
  FIXED_PROJECT_ID,
  FIXED_PROJECT_SLUG,
  isoTimestamp,
  makePlannedSprint,
  makeRepository,
  makeReviewSprint,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { createCloseSprintFlow } from '@src/application/flows/close-sprint/flow.ts';
import type { CloseSprintCtx } from '@src/application/flows/close-sprint/ctx.ts';
import type { CloseSprintDeps } from '@src/application/flows/close-sprint/deps.ts';
import { recordingAppendFile } from '@tests/fixtures/recording-append-file.ts';
import { recordingWriteFile } from '@tests/fixtures/recording-write-file.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import { unlockedSprintLockDeps } from '@tests/fixtures/pass-through-locker.ts';
import { withUpdate } from '@tests/fixtures/sprint-repo-update.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';

const NOW = isoTimestamp('2026-05-09T10:00:00.000Z');

/**
 * A buildable-but-never-executed distill composition. With `distillRequested: false` the chain's
 * `distill-gate` guard skips the body, so the inner leaves never run — but the sub-chain is still
 * built eagerly, so the deps must be shaped enough to construct (the AI / write / template ports
 * are stubs the gate prevents from ever firing). Wiring it makes the `distill-learnings` skipped
 * step appear in the trace, which the step-order fence locks immediately before the transition.
 */
const stubDistill = (): NonNullable<CloseSprintDeps['distill']> => ({
  deps: {
    interactiveAiFor: () => ({}) as never,
    runInTerminal: (() => {}) as never,
    templateLoader: {} as never,
    interactive: {} as never,
    writeFile: (() => {}) as never,
    logger: noopLogger,
    clock: () => FIXED_LATER,
  } as never,
  opts: {
    projectId: FIXED_PROJECT_ID,
    projectSlug: FIXED_PROJECT_SLUG,
    memoryRoot: absolutePath('/tmp/memory'),
    distillRoot: absolutePath('/tmp/distill'),
    repository: makeRepository(),
    ai: DEFAULT_SETTINGS.ai,
  },
});

const inMemorySprintRepo = (initial: Sprint): { readonly repo: SprintRepository; readonly current: () => Sprint } => {
  let current = initial;
  const repo = withUpdate({
    async findById(id: SprintId) {
      if (current.id === id) return Result.ok(current);
      return Result.error(new NotFoundError({ entity: 'sprint', id: String(id) }));
    },
    async save(sprint: Sprint) {
      current = sprint;
      return Result.ok(undefined);
    },
  }) as unknown as SprintRepository;
  return { repo, current: () => current };
};

describe('createCloseSprintFlow', () => {
  it('transitions a review sprint to done and persists with doneAt set', async () => {
    const sprint = makeReviewSprint();
    const sprintRepo = inMemorySprintRepo(sprint);

    const append = recordingAppendFile();
    const flow = createCloseSprintFlow({
      ...unlockedSprintLockDeps(),
      sprintRepo: sprintRepo.repo,
      clock: () => FIXED_LATER,
      logger: noopLogger,
      appendFile: append.fn,
      writeFile: createAtomicWriteFile(),
      progressFile: absolutePath('/tmp/progress.md'),
      distill: stubDistill(),
    });
    const runner = createRunner<CloseSprintCtx>({
      id: 'r-close-happy',
      element: flow,
      initialCtx: { sprintId: sprint.id, distillRequested: false },
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    // Step-order fence — the distill step (its `distill-gate` guard's skipped body name,
    // `distill-learnings`) MUST sit immediately before `transition-sprint-to-done` so a future
    // refactor cannot let the sprint flip to done before learnings are distilled.
    expect(runner.trace.map((t) => t.elementName)).toEqual([
      'load-sprint',
      'assert-sprint-status',
      'distill-learnings',
      'transition-sprint-to-done',
      'progress-journal-close',
    ]);
    const final = sprintRepo.current();
    expect(final.status).toBe('done');
    if (final.status === 'done') {
      const done: DoneSprint = final;
      expect(done.doneAt).toBe(FIXED_LATER);
    }
  });

  it('runs the always-on memory-mirror refresh immediately before the gated distill', async () => {
    const sprint = makeReviewSprint();
    const sprintRepo = inMemorySprintRepo(sprint);

    const append = recordingAppendFile();
    const flow = createCloseSprintFlow({
      ...unlockedSprintLockDeps(),
      sprintRepo: sprintRepo.repo,
      clock: () => FIXED_LATER,
      logger: noopLogger,
      appendFile: append.fn,
      writeFile: createAtomicWriteFile(),
      progressFile: absolutePath('/tmp/progress.md'),
      // No ledger on disk → the refresh leaf is a no-op, but it still appears in the trace.
      memoryMirror: {
        writeFile: recordingWriteFile().fn,
        memoryRoot: absolutePath('/tmp/memory'),
        projectId: FIXED_PROJECT_ID,
      },
      distill: stubDistill(),
    });
    const runner = createRunner<CloseSprintCtx>({
      id: 'r-close-mirror',
      element: flow,
      initialCtx: { sprintId: sprint.id, distillRequested: false },
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    // Step-order fence — the always-on `refresh-memory-mirror` sits AFTER the load/assert and BEFORE
    // the gated `distill-learnings`, which itself stays immediately before the transition.
    expect(runner.trace.map((t) => t.elementName)).toEqual([
      'load-sprint',
      'assert-sprint-status',
      'refresh-memory-mirror',
      'distill-learnings',
      'transition-sprint-to-done',
      'progress-journal-close',
    ]);
    expect(sprintRepo.current().status).toBe('done');
  });

  it('built with deps.distill omitted entirely — the distill-learnings step is absent from the trace', async () => {
    const sprint = makeReviewSprint();
    const sprintRepo = inMemorySprintRepo(sprint);

    const append = recordingAppendFile();
    const flow = createCloseSprintFlow({
      ...unlockedSprintLockDeps(),
      sprintRepo: sprintRepo.repo,
      clock: () => FIXED_LATER,
      logger: noopLogger,
      appendFile: append.fn,
      writeFile: createAtomicWriteFile(),
      progressFile: absolutePath('/tmp/progress.md'),
      // No `distill` dep at all — the distill step must be omitted from the chain entirely,
      // not merely skipped by its inner gate (that case is covered by the happy-path test above,
      // which passes `stubDistill()` and asserts the guard's `distill-learnings` name still
      // appears in the trace even when `distillRequested` is false).
    });
    const runner = createRunner<CloseSprintCtx>({
      id: 'r-close-no-distill-dep',
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

  it('refuses to close a sprint that is not in review (assert-status rejects)', async () => {
    const sprint = makePlannedSprint();
    const sprintRepo = inMemorySprintRepo(sprint);

    const append = recordingAppendFile();
    const flow = createCloseSprintFlow({
      ...unlockedSprintLockDeps(),
      sprintRepo: sprintRepo.repo,
      clock: () => NOW,
      logger: noopLogger,
      appendFile: append.fn,
      writeFile: createAtomicWriteFile(),
      progressFile: absolutePath('/tmp/progress.md'),
    });
    const runner = createRunner<CloseSprintCtx>({
      id: 'r-close-wrong-status',
      element: flow,
      initialCtx: { sprintId: sprint.id, distillRequested: false },
    });
    await runner.start();

    expect(runner.status).toBe('failed');
    // Sprint stays in `planned` — no partial transition lands on disk.
    expect(sprintRepo.current().status).toBe('planned');
  });

  it('keeps a ticket link published from another terminal while the close waits on its confirm', async () => {
    const sprint = makeReviewSprint();
    const ticket = sprint.tickets[0];
    if (ticket === undefined) throw new Error('fixture has no ticket');
    const sprintRepo = inMemorySprintRepo(sprint);
    const blocked = markTaskBlocked(makeTodoTask({ name: 'stuck' }), 'ran out of attempts', 'own');
    if (!blocked.ok) throw new Error(blocked.error.message);
    const tasks: readonly Task[] = [blocked.value];
    const url = 'https://github.com/acme/repo/issues/42';
    const interactive = {
      async askConfirm() {
        // `ralphctl ticket publish` lands while the operator reads the blocked-task prompt.
        const linked = await sprintRepo.repo.update(sprint.id, (fresh) => attachTicketLink(fresh, ticket.id, url));
        if (!linked.ok) throw new Error(linked.error.message);
        return Result.ok(true);
      },
    } as unknown as InteractivePrompt;

    const flow = createCloseSprintFlow({
      ...unlockedSprintLockDeps(),
      sprintRepo: sprintRepo.repo,
      clock: () => FIXED_LATER,
      logger: noopLogger,
      appendFile: recordingAppendFile().fn,
      writeFile: createAtomicWriteFile(),
      progressFile: absolutePath('/tmp/progress.md'),
      blockedTasksGate: { taskRepo: { findBySprintId: async () => Result.ok(tasks) }, interactive },
    });
    const runner = createRunner<CloseSprintCtx>({
      id: 'r-close-concurrent-link',
      element: flow,
      initialCtx: { sprintId: sprint.id, distillRequested: false },
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    const final = sprintRepo.current();
    expect(final.status).toBe('done');
    expect(final.tickets[0]?.link).toBe(url);
  });
});
