import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { DoneSprint, Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import {
  absolutePath,
  FIXED_LATER,
  FIXED_PROJECT_ID,
  isoTimestamp,
  makePlannedSprint,
  makeRepository,
  makeReviewSprint,
} from '@tests/fixtures/domain.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { createCloseSprintFlow } from '@src/application/flows/close-sprint/flow.ts';
import type { CloseSprintCtx } from '@src/application/flows/close-sprint/ctx.ts';
import type { CloseSprintDeps } from '@src/application/flows/close-sprint/deps.ts';
import { recordingAppendFile } from '@tests/fixtures/recording-append-file.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';

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
    memoryRoot: absolutePath('/tmp/memory'),
    distillRoot: absolutePath('/tmp/distill'),
    repository: makeRepository(),
    ai: DEFAULT_SETTINGS.ai,
  },
});

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

describe('createCloseSprintFlow', () => {
  it('transitions a review sprint to done and persists with doneAt set', async () => {
    const sprint = makeReviewSprint();
    const sprintRepo = inMemorySprintRepo(sprint);

    const append = recordingAppendFile();
    const flow = createCloseSprintFlow({
      sprintRepo: sprintRepo.repo,
      clock: () => FIXED_LATER,
      logger: noopLogger,
      appendFile: append.fn,
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

  it('refuses to close a sprint that is not in review (assert-status rejects)', async () => {
    const sprint = makePlannedSprint();
    const sprintRepo = inMemorySprintRepo(sprint);

    const append = recordingAppendFile();
    const flow = createCloseSprintFlow({
      sprintRepo: sprintRepo.repo,
      clock: () => NOW,
      logger: noopLogger,
      appendFile: append.fn,
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
});
