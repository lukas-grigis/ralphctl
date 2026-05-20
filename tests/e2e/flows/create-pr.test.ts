import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { PullRequestCreator, PullRequestCreatorInput } from '@src/business/scm/pull-request-creator.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { FindTasksBySprintId } from '@src/domain/repository/task/find-tasks-by-sprint-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { setExecutionBranch } from '@src/domain/entity/sprint-execution.ts';
import { absolutePath, FIXED_LATER, makeReviewSprint } from '@tests/fixtures/domain.ts';
import { createSprintExecution } from '@src/domain/entity/sprint-execution.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { createCreatePrFlow } from '@src/application/flows/create-pr/flow.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';

const fakeSprintRepo = (sprint: Sprint): SprintRepository =>
  ({
    async findById(id: SprintId) {
      if (id === sprint.id) return Result.ok(sprint);
      return Result.error(new NotFoundError({ entity: 'sprint', id: String(id) }));
    },
  }) as SprintRepository;

const inMemoryExecutionRepo = (
  initial: SprintExecution
): { repo: SprintExecutionRepository; saves: SprintExecution[] } => {
  let current = initial;
  const saves: SprintExecution[] = [];
  const repo: SprintExecutionRepository = {
    async findById(id: SprintId) {
      if (id !== current.sprintId)
        return Result.error(new NotFoundError({ entity: 'sprint-execution', id: String(id) }));
      return Result.ok(current);
    },
    async save(exec: SprintExecution) {
      current = exec;
      saves.push(exec);
      return Result.ok(undefined);
    },
  } as SprintExecutionRepository;
  return { repo, saves };
};

const recordingPullRequestCreator = (
  url: string
): { creator: PullRequestCreator; calls: PullRequestCreatorInput[] } => {
  const calls: PullRequestCreatorInput[] = [];
  const creator: PullRequestCreator = async (input) => {
    calls.push(input);
    return Result.ok({ url, platform: 'github' });
  };
  return { creator, calls };
};

const failingPullRequestCreator = (): PullRequestCreator => async () =>
  Result.error(new StorageError({ subCode: 'io', message: 'gh pr create failed: auth' }));

const emptyTaskRepo = (): FindTasksBySprintId => ({
  async findBySprintId() {
    return Result.ok([]);
  },
});

const fixedClock = (): typeof FIXED_LATER => FIXED_LATER;

describe('create-pr flow — happy path', () => {
  it('opens the PR and persists the URL on the sprint execution', async () => {
    const sprint = makeReviewSprint();
    const exec = setExecutionBranch(createSprintExecution({ sprintId: sprint.id }), 'feature/x');
    const execRepo = inMemoryExecutionRepo(exec);
    const pr = recordingPullRequestCreator('https://github.com/o/r/pull/42');

    const flow = createCreatePrFlow({
      sprintRepo: fakeSprintRepo(sprint),
      sprintExecutionRepo: execRepo.repo,
      taskRepo: emptyTaskRepo(),
      pullRequestCreator: pr.creator,
      eventBus: createInMemoryEventBus(),
      clock: fixedClock,
    });
    const result = await flow.execute({
      input: { sprintId: sprint.id, cwd: absolutePath('/tmp/repo'), base: 'main', draft: false },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.output!.url).toBe('https://github.com/o/r/pull/42');
    expect(pr.calls).toHaveLength(1);
    expect(pr.calls[0]?.branch).toBe('feature/x');
    expect(pr.calls[0]?.base).toBe('main');
    expect(pr.calls[0]?.title).toBe(sprint.name);
    expect(execRepo.saves).toHaveLength(1);
    expect(String(execRepo.saves[0]?.pullRequestUrl)).toBe('https://github.com/o/r/pull/42');
  });

  it('honours user-supplied title and body overrides', async () => {
    const sprint = makeReviewSprint();
    const exec = setExecutionBranch(createSprintExecution({ sprintId: sprint.id }), 'feature/y');
    const pr = recordingPullRequestCreator('https://github.com/o/r/pull/9');

    const flow = createCreatePrFlow({
      sprintRepo: fakeSprintRepo(sprint),
      sprintExecutionRepo: inMemoryExecutionRepo(exec).repo,
      taskRepo: emptyTaskRepo(),
      pullRequestCreator: pr.creator,
      eventBus: createInMemoryEventBus(),
      clock: fixedClock,
    });
    const result = await flow.execute({
      input: {
        sprintId: sprint.id,
        cwd: absolutePath('/tmp/repo'),
        base: 'main',
        draft: true,
        title: 'My PR Title',
        body: 'My PR Body',
      },
    });

    expect(result.ok).toBe(true);
    expect(pr.calls[0]?.title).toBe('My PR Title');
    expect(pr.calls[0]?.body).toBe('My PR Body');
    expect(pr.calls[0]?.draft).toBe(true);
  });
});

describe('create-pr flow — failures', () => {
  it('does not save the execution when PR creation fails', async () => {
    const sprint = makeReviewSprint();
    const exec = setExecutionBranch(createSprintExecution({ sprintId: sprint.id }), 'feature/x');
    const execRepo = inMemoryExecutionRepo(exec);

    const flow = createCreatePrFlow({
      sprintRepo: fakeSprintRepo(sprint),
      sprintExecutionRepo: execRepo.repo,
      taskRepo: emptyTaskRepo(),
      pullRequestCreator: failingPullRequestCreator(),
      eventBus: createInMemoryEventBus(),
      clock: fixedClock,
    });
    const result = await flow.execute({
      input: { sprintId: sprint.id, cwd: absolutePath('/tmp/repo'), base: 'main', draft: false },
    });

    expect(result.ok).toBe(false);
    expect(execRepo.saves).toHaveLength(0);
  });

  it('rejects an execution without a branch (no run flow yet)', async () => {
    const sprint = makeReviewSprint();
    const exec = createSprintExecution({ sprintId: sprint.id });
    expect(exec.branch).toBeNull();

    const flow = createCreatePrFlow({
      sprintRepo: fakeSprintRepo(sprint),
      sprintExecutionRepo: inMemoryExecutionRepo(exec).repo,
      taskRepo: emptyTaskRepo(),
      pullRequestCreator: recordingPullRequestCreator('unused').creator,
      eventBus: createInMemoryEventBus(),
      clock: fixedClock,
    });
    const result = await flow.execute({
      input: { sprintId: sprint.id, cwd: absolutePath('/tmp/repo'), base: 'main', draft: false },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(InvalidStateError);
  });
});
