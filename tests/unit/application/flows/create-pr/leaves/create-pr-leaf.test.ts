import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { PullRequestCreator, PullRequestCreatorInput } from '@src/business/scm/pull-request-creator.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import { createSprintExecution, setExecutionBranch } from '@src/domain/entity/sprint-execution.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { FindTasksBySprintId } from '@src/domain/repository/task/find-tasks-by-sprint-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { absolutePath, FIXED_LATER, makeReviewSprint } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { createCreatePrLeaf } from '@src/application/flows/create-pr/leaves/create-pr-leaf.ts';
import type { CreatePrDeps } from '@src/application/flows/create-pr/deps.ts';
import type { CreatePrCtx } from '@src/application/flows/create-pr/ctx.ts';

/**
 * The create-pr leaf threads PR title + body via this precedence:
 *
 *   explicit input override  >  ctx.aiContent  >  template-derived (derivePrContent)
 *
 * These tests pin each level so a future refactor can't quietly invert them.
 */

const fakeSprintRepo = (sprint: Sprint): SprintRepository =>
  ({
    async findById(id: SprintId) {
      if (id === sprint.id) return Result.ok(sprint);
      return Result.error(new NotFoundError({ entity: 'sprint', id: String(id) }));
    },
  }) as SprintRepository;

const inMemoryExecutionRepo = (initial: SprintExecution): SprintExecutionRepository =>
  ({
    async findById(id: SprintId) {
      if (id !== initial.sprintId)
        return Result.error(new NotFoundError({ entity: 'sprint-execution', id: String(id) }));
      return Result.ok(initial);
    },
    async save() {
      return Result.ok(undefined);
    },
    async remove() {
      return Result.ok(undefined);
    },
  }) as SprintExecutionRepository;

const stubGit: GitRunner = {
  async run() {
    return Result.error(
      new StorageError({ subCode: 'io', message: 'test: git should not be called from create-pr leaf' })
    );
  },
};
const stubProvider: HeadlessAiProvider = {
  async generate() {
    return Result.error(new StorageError({ subCode: 'io', message: 'test: provider should not be called' }));
  },
};
const stubTemplateLoader: TemplateLoader = {
  async load() {
    return Result.error(new StorageError({ subCode: 'io', message: 'test: loader should not be called' }));
  },
};
const stubWriteFile: CreatePrDeps['writeFile'] = async () =>
  Result.error(new StorageError({ subCode: 'io', message: 'test: writeFile should not be called' }));

const captureCreator = (): { creator: PullRequestCreator; calls: PullRequestCreatorInput[] } => {
  const calls: PullRequestCreatorInput[] = [];
  return {
    calls,
    creator: async (input) => {
      calls.push(input);
      return Result.ok({ url: 'https://github.com/o/r/pull/1', platform: 'github' });
    },
  };
};

const buildDeps = (sprint: Sprint, exec: SprintExecution, creator: PullRequestCreator): CreatePrDeps => ({
  sprintRepo: fakeSprintRepo(sprint),
  sprintExecutionRepo: inMemoryExecutionRepo(exec),
  taskRepo: {
    async findBySprintId() {
      return Result.ok([]);
    },
  } satisfies FindTasksBySprintId,
  pullRequestCreator: creator,
  gitRunner: stubGit,
  eventBus: createInMemoryEventBus(),
  clock: () => FIXED_LATER,
  provider: stubProvider,
  templateLoader: stubTemplateLoader,
  writeFile: stubWriteFile,
  logger: noopLogger,
  model: 'test-model',
});

describe('createCreatePrLeaf — title/body precedence', () => {
  const sprint = makeReviewSprint();
  const exec = setExecutionBranch(createSprintExecution({ sprintId: sprint.id }), 'feature/x');

  it('uses template-derived content when no override and no aiContent', async () => {
    const { creator, calls } = captureCreator();
    const leaf = createCreatePrLeaf(buildDeps(sprint, exec, creator));
    const ctx: CreatePrCtx = {
      input: {
        sprintId: sprint.id,
        cwd: absolutePath('/tmp/repo'),
        sprintDir: absolutePath('/tmp/sprint-dir'),
        base: 'main',
        draft: false,
      },
    };
    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(true);
    expect(calls[0]?.title).toBe(sprint.name);
    expect(calls[0]?.body).toContain(`# ${sprint.name}`);
  });

  it('uses ctx.aiContent when present and no explicit override (AI > template)', async () => {
    const { creator, calls } = captureCreator();
    const leaf = createCreatePrLeaf(buildDeps(sprint, exec, creator));
    const ctx: CreatePrCtx = {
      input: {
        sprintId: sprint.id,
        cwd: absolutePath('/tmp/repo'),
        sprintDir: absolutePath('/tmp/sprint-dir'),
        base: 'main',
        draft: false,
      },
      aiContent: { title: 'AI title', body: 'AI body' },
    };
    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(true);
    expect(calls[0]?.title).toBe('AI title');
    expect(calls[0]?.body).toBe('AI body');
  });

  it('explicit override beats both aiContent and template (override > AI > template)', async () => {
    const { creator, calls } = captureCreator();
    const leaf = createCreatePrLeaf(buildDeps(sprint, exec, creator));
    const ctx: CreatePrCtx = {
      input: {
        sprintId: sprint.id,
        cwd: absolutePath('/tmp/repo'),
        sprintDir: absolutePath('/tmp/sprint-dir'),
        base: 'main',
        draft: false,
        title: 'Explicit title',
        body: 'Explicit body',
      },
      aiContent: { title: 'AI title', body: 'AI body' },
    };
    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(true);
    expect(calls[0]?.title).toBe('Explicit title');
    expect(calls[0]?.body).toBe('Explicit body');
  });

  it('partial override: explicit title only — body falls back to aiContent', async () => {
    const { creator, calls } = captureCreator();
    const leaf = createCreatePrLeaf(buildDeps(sprint, exec, creator));
    const ctx: CreatePrCtx = {
      input: {
        sprintId: sprint.id,
        cwd: absolutePath('/tmp/repo'),
        sprintDir: absolutePath('/tmp/sprint-dir'),
        base: 'main',
        draft: false,
        title: 'Explicit title',
      },
      aiContent: { title: 'AI title', body: 'AI body' },
    };
    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(true);
    expect(calls[0]?.title).toBe('Explicit title');
    expect(calls[0]?.body).toBe('AI body');
  });
});
