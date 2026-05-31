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
import type { Task } from '@src/domain/entity/task.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import {
  absolutePath,
  FIXED_LATER,
  makeApprovedTicket,
  makeDoneTask,
  makeReviewSprint,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { createCreatePrFlow } from '@src/application/flows/create-pr/flow.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import type { CreatePrDeps } from '@src/application/flows/create-pr/deps.ts';
import type { HeadlessAiProvider, ProviderOutput } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { promises as fsp } from 'node:fs';
import { dirname } from 'node:path';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import type { AiSignalEvent } from '@src/business/observability/events.ts';

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

const recordingTaskRepo = (tasks: readonly Task[]): FindTasksBySprintId => ({
  async findBySprintId() {
    return Result.ok(tasks);
  },
});

const failingTaskRepo = (): FindTasksBySprintId => ({
  async findBySprintId() {
    return Result.error(new StorageError({ subCode: 'io', message: 'task store unreachable' }));
  },
});

// Fake git runner: answers `rev-parse --abbrev-ref HEAD` with the sprint branch (so the
// push-branch leaf's drift guard passes) and records each `git push` argv.
const recordingGitRunner = (branch: string): { runner: GitRunner; pushes: Array<readonly string[]> } => {
  const pushes: Array<readonly string[]> = [];
  const runner: GitRunner = {
    async run(_cwd, args) {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        return Result.ok({ stdout: `${branch}\n`, stderr: '', exitCode: 0 });
      }
      if (args[0] === 'push') {
        pushes.push(args);
        return Result.ok({ stdout: '', stderr: '', exitCode: 0 });
      }
      return Result.error(new StorageError({ subCode: 'io', message: `test: unexpected git ${args.join(' ')}` }));
    },
  };
  return { runner, pushes };
};

const fixedClock = (): typeof FIXED_LATER => FIXED_LATER;

// AI-step stubs — used when `useAi: false` (the existing legacy describe blocks). The
// stubs throw on call so a regression that accidentally exercises the AI sub-chain when
// `useAi: false` surfaces loudly instead of silently degrading.
const refusingProvider: HeadlessAiProvider = {
  async generate() {
    return Result.error(new StorageError({ subCode: 'io', message: 'test: provider should not be called' }));
  },
};
const refusingTemplateLoader: TemplateLoader = {
  async load() {
    return Result.error(new StorageError({ subCode: 'io', message: 'test: loader should not be called' }));
  },
};
const refusingWriteFile: CreatePrDeps['writeFile'] = async () =>
  Result.error(new StorageError({ subCode: 'io', message: 'test: writeFile should not be called' }));

const stubAiDeps = {
  provider: refusingProvider,
  templateLoader: refusingTemplateLoader,
  writeFile: refusingWriteFile,
  logger: noopLogger,
  model: 'test-model',
} satisfies Pick<CreatePrDeps, 'provider' | 'templateLoader' | 'writeFile' | 'logger' | 'model'>;

describe('create-pr flow — happy path', () => {
  it('pushes the branch, then opens the PR and persists the URL on the sprint execution', async () => {
    const sprint = makeReviewSprint();
    const exec = setExecutionBranch(createSprintExecution({ sprintId: sprint.id }), 'feature/x');
    const execRepo = inMemoryExecutionRepo(exec);
    const pr = recordingPullRequestCreator('https://github.com/o/r/pull/42');
    const git = recordingGitRunner('feature/x');
    // Capture call ordering across both side effects to assert push-before-PR.
    const callOrder: string[] = [];
    const orderedGitRunner: GitRunner = {
      async run(cwd, args) {
        const r = await git.runner.run(cwd, args);
        if (args[0] === 'push') callOrder.push('push');
        return r;
      },
    };
    const orderedPrCreator: PullRequestCreator = async (input) => {
      callOrder.push('pr');
      return pr.creator(input);
    };

    const flow = createCreatePrFlow(
      {
        sprintRepo: fakeSprintRepo(sprint),
        sprintExecutionRepo: execRepo.repo,
        taskRepo: emptyTaskRepo(),
        pullRequestCreator: orderedPrCreator,
        gitRunner: orderedGitRunner,
        eventBus: createInMemoryEventBus(),
        clock: fixedClock,
        ...stubAiDeps,
      },
      { useAi: false }
    );
    const result = await flow.execute({
      input: {
        sprintId: sprint.id,
        cwd: absolutePath('/tmp/repo'),
        sprintDir: absolutePath('/tmp/sprint-dir'),
        base: 'main',
        draft: false,
      },
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
    // Push leaf ran a `git push -u origin <branch>` and did so before the PR was opened.
    expect(git.pushes).toEqual([['push', '-u', 'origin', 'feature/x']]);
    expect(callOrder).toEqual(['push', 'pr']);
  });

  it('loads tasks from the repo and emits `## Tasks` + `## Related issues` (with `- Closes <ref>`) in the body', async () => {
    const sprint = makeReviewSprint({
      tickets: [
        makeApprovedTicket({ title: 'first', externalRef: '#123' }),
        makeApprovedTicket({ title: 'second', externalRef: '!456' }),
      ],
    });
    const done = makeDoneTask({ name: 'shipped task' });
    const todo = makeTodoTask({ name: 'still-pending' });
    const exec = setExecutionBranch(createSprintExecution({ sprintId: sprint.id }), 'feature/x');
    const pr = recordingPullRequestCreator('https://github.com/o/r/pull/77');

    const flow = createCreatePrFlow(
      {
        sprintRepo: fakeSprintRepo(sprint),
        sprintExecutionRepo: inMemoryExecutionRepo(exec).repo,
        taskRepo: recordingTaskRepo([done, todo]),
        pullRequestCreator: pr.creator,
        gitRunner: recordingGitRunner('feature/x').runner,
        eventBus: createInMemoryEventBus(),
        clock: fixedClock,
        ...stubAiDeps,
      },
      { useAi: false }
    );
    const result = await flow.execute({
      input: {
        sprintId: sprint.id,
        cwd: absolutePath('/tmp/repo'),
        sprintDir: absolutePath('/tmp/sprint-dir'),
        base: 'main',
        draft: false,
      },
    });

    expect(result.ok).toBe(true);
    expect(pr.calls).toHaveLength(1);
    const body = pr.calls[0]?.body ?? '';
    expect(body).toContain('## Tasks');
    expect(body).toContain('- shipped task');
    expect(body).not.toContain('still-pending');
    expect(body).toContain('## Related issues');
    expect(body).toContain('- Closes #123');
    expect(body).toContain('- Closes !456');
  });

  it('honours user-supplied title and body overrides', async () => {
    const sprint = makeReviewSprint();
    const exec = setExecutionBranch(createSprintExecution({ sprintId: sprint.id }), 'feature/y');
    const pr = recordingPullRequestCreator('https://github.com/o/r/pull/9');

    const flow = createCreatePrFlow(
      {
        sprintRepo: fakeSprintRepo(sprint),
        sprintExecutionRepo: inMemoryExecutionRepo(exec).repo,
        taskRepo: emptyTaskRepo(),
        pullRequestCreator: pr.creator,
        gitRunner: recordingGitRunner('feature/y').runner,
        eventBus: createInMemoryEventBus(),
        clock: fixedClock,
        ...stubAiDeps,
      },
      { useAi: false }
    );
    const result = await flow.execute({
      input: {
        sprintId: sprint.id,
        cwd: absolutePath('/tmp/repo'),
        sprintDir: absolutePath('/tmp/sprint-dir'),
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

    const flow = createCreatePrFlow(
      {
        sprintRepo: fakeSprintRepo(sprint),
        sprintExecutionRepo: execRepo.repo,
        taskRepo: emptyTaskRepo(),
        pullRequestCreator: failingPullRequestCreator(),
        gitRunner: recordingGitRunner('feature/x').runner,
        eventBus: createInMemoryEventBus(),
        clock: fixedClock,
        ...stubAiDeps,
      },
      { useAi: false }
    );
    const result = await flow.execute({
      input: {
        sprintId: sprint.id,
        cwd: absolutePath('/tmp/repo'),
        sprintDir: absolutePath('/tmp/sprint-dir'),
        base: 'main',
        draft: false,
      },
    });

    expect(result.ok).toBe(false);
    expect(execRepo.saves).toHaveLength(0);
  });

  it('aborts without opening a PR when taskRepo.findBySprintId fails', async () => {
    const sprint = makeReviewSprint();
    const exec = setExecutionBranch(createSprintExecution({ sprintId: sprint.id }), 'feature/x');
    const execRepo = inMemoryExecutionRepo(exec);
    const pr = recordingPullRequestCreator('https://github.com/o/r/pull/unused');

    const flow = createCreatePrFlow(
      {
        sprintRepo: fakeSprintRepo(sprint),
        sprintExecutionRepo: execRepo.repo,
        taskRepo: failingTaskRepo(),
        pullRequestCreator: pr.creator,
        gitRunner: recordingGitRunner('feature/x').runner,
        eventBus: createInMemoryEventBus(),
        clock: fixedClock,
        ...stubAiDeps,
      },
      { useAi: false }
    );
    const result = await flow.execute({
      input: {
        sprintId: sprint.id,
        cwd: absolutePath('/tmp/repo'),
        sprintDir: absolutePath('/tmp/sprint-dir'),
        base: 'main',
        draft: false,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(StorageError);
    expect(pr.calls).toHaveLength(0);
    expect(execRepo.saves).toHaveLength(0);
  });

  it('rejects an execution without a branch (no run flow yet) — useAi=false', async () => {
    const sprint = makeReviewSprint();
    const exec = createSprintExecution({ sprintId: sprint.id });
    expect(exec.branch).toBeNull();

    const flow = createCreatePrFlow(
      {
        sprintRepo: fakeSprintRepo(sprint),
        sprintExecutionRepo: inMemoryExecutionRepo(exec).repo,
        taskRepo: emptyTaskRepo(),
        pullRequestCreator: recordingPullRequestCreator('unused').creator,
        gitRunner: recordingGitRunner('unused').runner,
        eventBus: createInMemoryEventBus(),
        clock: fixedClock,
        ...stubAiDeps,
      },
      { useAi: false }
    );
    const result = await flow.execute({
      input: {
        sprintId: sprint.id,
        cwd: absolutePath('/tmp/repo'),
        sprintDir: absolutePath('/tmp/sprint-dir'),
        base: 'main',
        draft: false,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(InvalidStateError);
  });
});

describe('create-pr flow — useAi=true happy path', () => {
  it('runs the AI sub-chain, writes pr-content.md, and threads ai-authored title/body into the PR', async () => {
    const tmp = await makeTmpRoot();
    try {
      const sprint = makeReviewSprint();
      const exec = setExecutionBranch(createSprintExecution({ sprintId: sprint.id }), 'feature/ai');
      const pr = recordingPullRequestCreator('https://github.com/o/r/pull/100');

      // Fake provider that writes a valid signals.json containing one pr-content signal.
      const aiTitle = 'Add AI-authored title';
      const aiBody = 'Summary.\n\n## Changes\n\n- nothing.\n\n## Test plan\n\n- [ ] verify.';
      const fakeProvider: HeadlessAiProvider = {
        async generate(session) {
          await fsp.mkdir(dirname(String(session.signalsFile)), { recursive: true });
          const payload = {
            schemaVersion: 1,
            signals: [
              {
                type: 'pr-content',
                title: aiTitle,
                body: aiBody,
                timestamp: '2026-05-23T10:00:00.000Z',
              },
            ],
          };
          await fsp.writeFile(String(session.signalsFile), JSON.stringify(payload), 'utf8');
          return Result.ok({
            signalsFile: session.signalsFile,
            exitCode: 0,
          } satisfies ProviderOutput) as Result<ProviderOutput, DomainError>;
        },
      };

      // Real writeFile so prompt.md + pr-content.md actually land on disk.
      const realWriteFile: CreatePrDeps['writeFile'] = async (path, content) => {
        try {
          await fsp.mkdir(dirname(String(path)), { recursive: true });
          await fsp.writeFile(String(path), content, 'utf8');
          return Result.ok(undefined);
        } catch (cause) {
          return Result.error(new StorageError({ subCode: 'io', message: `test writeFile: ${String(cause)}` }));
        }
      };

      const eventBus = createInMemoryEventBus();
      const aiEvents: AiSignalEvent[] = [];
      eventBus.subscribe((e) => {
        if (e.type === 'ai-signal') aiEvents.push(e);
      });

      const flow = createCreatePrFlow(
        {
          sprintRepo: fakeSprintRepo(sprint),
          sprintExecutionRepo: inMemoryExecutionRepo(exec).repo,
          taskRepo: emptyTaskRepo(),
          pullRequestCreator: pr.creator,
          gitRunner: recordingGitRunner('feature/ai').runner,
          eventBus,
          clock: fixedClock,
          provider: fakeProvider,
          templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
          writeFile: realWriteFile,
          logger: noopLogger,
          model: 'test-model',
        },
        { useAi: true }
      );
      const result = await flow.execute({
        input: { sprintId: sprint.id, cwd: tmp.root, sprintDir: tmp.root, base: 'main', draft: false },
      });

      expect(result.ok).toBe(true);
      // AI title + body landed on the PR, not the template-derived default.
      expect(pr.calls[0]?.title).toBe(aiTitle);
      expect(pr.calls[0]?.body).toBe(aiBody);
      // The sidecar file landed under `<sprintDir>/create-pr/<branch-slug>/` — same convention
      // implement / refine / plan use, so the user's repo working tree stays untouched.
      const sidecarPath = `${String(tmp.root)}/create-pr/feature-ai/pr-content.md`;
      const sidecarBody = await fsp.readFile(sidecarPath, 'utf8');
      expect(sidecarBody).toContain(`# ${aiTitle}`);
      expect(sidecarBody).toContain(aiBody);
      // The validated pr-content signal fanned out to the bus.
      expect(aiEvents.map((e) => e.signal.type)).toContain('pr-content');
    } finally {
      await tmp.cleanup();
    }
  });

  it('falls back to the template-derived content when the provider fails (AI step is best-effort)', async () => {
    const tmp = await makeTmpRoot();
    try {
      const sprint = makeReviewSprint();
      const exec = setExecutionBranch(createSprintExecution({ sprintId: sprint.id }), 'feature/fallback');
      const pr = recordingPullRequestCreator('https://github.com/o/r/pull/101');

      // Provider always errors; the leaf must swallow and degrade.
      const failingProvider: HeadlessAiProvider = {
        async generate() {
          return Result.error(new StorageError({ subCode: 'io', message: 'simulated provider crash' }));
        },
      };

      const realWriteFile: CreatePrDeps['writeFile'] = async (path, content) => {
        try {
          await fsp.mkdir(dirname(String(path)), { recursive: true });
          await fsp.writeFile(String(path), content, 'utf8');
          return Result.ok(undefined);
        } catch (cause) {
          return Result.error(new StorageError({ subCode: 'io', message: `test writeFile: ${String(cause)}` }));
        }
      };

      const flow = createCreatePrFlow(
        {
          sprintRepo: fakeSprintRepo(sprint),
          sprintExecutionRepo: inMemoryExecutionRepo(exec).repo,
          taskRepo: emptyTaskRepo(),
          pullRequestCreator: pr.creator,
          gitRunner: recordingGitRunner('feature/fallback').runner,
          eventBus: createInMemoryEventBus(),
          clock: fixedClock,
          provider: failingProvider,
          templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
          writeFile: realWriteFile,
          logger: noopLogger,
          model: 'test-model',
        },
        { useAi: true }
      );
      const result = await flow.execute({
        input: { sprintId: sprint.id, cwd: tmp.root, sprintDir: tmp.root, base: 'main', draft: false },
      });

      expect(result.ok).toBe(true);
      // Template-derived title is the sprint name; no AI was successful.
      expect(pr.calls[0]?.title).toBe(sprint.name);
    } finally {
      await tmp.cleanup();
    }
  });
});
