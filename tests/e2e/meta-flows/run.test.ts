import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import {
  absolutePath,
  FIXED_LATER,
  FIXED_REPOSITORY_ID,
  isoTimestamp,
  makeApprovedTicket,
  makePlannedSprint,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';
import { createSprintExecution, setExecutionBranch } from '@src/domain/entity/sprint-execution.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import type { GitRunner, GitRunResult } from '@src/integration/io/git-runner.ts';
import type { ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import { writeJsonAtomic } from '@src/integration/io/fs.ts';
import type { Choice, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { AskConfirmInput } from '@src/business/interactive/prompt.ts';
import { createInMemorySink } from '@tests/fixtures/in-memory-sink.ts';
import { createFileLocker } from '@src/integration/io/file-locker.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { createRunFlow } from '@src/application/flows/_meta/run/flow.ts';
import { emptySkillSource, noopSkillsAdapter } from '@tests/fixtures/skills-fakes.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import { createAppendFile } from '@src/integration/io/append-file-adapter.ts';

const FAKE_CWD = absolutePath('/tmp/ralph/fake-cwd');
const FAKE_REPOSITORIES = new Map([[FIXED_REPOSITORY_ID, { path: FAKE_CWD, name: 'fake-repo' }]]);
// Per-file-run unique memory root (the real AppendFile adapter writes the ledger here) so concurrent
// vitest workers / repeated execs never collide on a shared `/tmp` path; torn down in afterAll.
const FAKE_MEMORY_ROOT = absolutePath(mkdtempSync(join(tmpdir(), 'ralphctl-run-e2e-memory-')));
const FAKE_PROJECT_ID = 'proj-run-e2e';
afterAll(() => rmSync(String(FAKE_MEMORY_ROOT), { recursive: true, force: true }));
const NOW = isoTimestamp('2026-05-09T10:00:00.000Z');

const inMemorySprintRepo = (initial: Sprint): { repo: SprintRepository; current: () => Sprint } => {
  let current: Sprint = initial;
  return {
    repo: {
      async findById(id: SprintId) {
        if (current.id === id) return Result.ok(current);
        return Result.error(new NotFoundError({ entity: 'sprint', id: String(id) }));
      },
      async save(sprint: Sprint) {
        current = sprint;
        return Result.ok(undefined);
      },
      async list() {
        return Result.ok([current]);
      },
    } as unknown as SprintRepository,
    current: () => current,
  };
};

const inMemoryExecutionRepo = (initial: SprintExecution): SprintExecutionRepository => {
  let current = initial;
  return {
    async findById(id: SprintId) {
      if (current.sprintId === id) return Result.ok(current);
      return Result.error(new NotFoundError({ entity: 'sprint-execution', id: String(id) }));
    },
    async save(next: SprintExecution) {
      current = next;
      return Result.ok(undefined);
    },
    async remove() {
      return Result.ok(undefined);
    },
  };
};

const inMemoryTaskRepo = (initial: readonly Task[]): { repo: TaskRepository; tasks: () => readonly Task[] } => {
  let store: Task[] = [...initial];
  const repo: TaskRepository = {
    async findBySprintId() {
      const page: readonly Task[] = store;
      return Result.ok(page);
    },
    async findById(_, taskId) {
      const t = store.find((tt) => tt.id === taskId);
      if (t === undefined) return Result.error(new NotFoundError({ entity: 'task', id: String(taskId) }));
      return Result.ok(t);
    },
    async update(_, task) {
      const idx = store.findIndex((t) => t.id === task.id);
      if (idx >= 0) store[idx] = task;
      else store = [...store, task];
      return Result.ok(undefined);
    },
    async saveAll(_, tasks) {
      store = [...tasks];
      return Result.ok(undefined);
    },
  };
  return { repo, tasks: () => store };
};

const okGit = (stdout = '', exitCode = 0): Result<GitRunResult, StorageError> =>
  Result.ok({ stdout, stderr: '', exitCode });

const makeCleanGit = (): GitRunner => {
  let head = 'main';
  return {
    async run(_, args) {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') return okGit(`${head}\n`);
      if (args[0] === 'show-ref') return okGit('', 1);
      if (args[0] === 'checkout') {
        const target = args[1] === '-b' ? args[2] : args[1];
        if (target !== undefined) head = target;
        return okGit('');
      }
      return okGit('');
    },
  };
};

const cleanGit: GitRunner = makeCleanGit();

const passingShell: ShellScriptRunner = {
  async run() {
    return Result.ok({ passed: true, exitCode: 0, output: '', durationMs: 0 });
  },
};

// Per-role signal sets. The audit-[09] generator contract rejects `evaluation` signals
// (only the evaluator emits those); emitting both on the generator's signalsFile would
// now fail Zod validation. Dispatch by path so each role's signalsFile carries the
// signals its leaf accepts.
const passingProvider: HeadlessAiProvider = {
  async generate(session) {
    const isEvaluator = String(session.signalsFile).includes('/evaluator/');
    const signals = isEvaluator
      ? [{ type: 'evaluation' as const, status: 'passed' as const, dimensions: [], timestamp: NOW }]
      : [{ type: 'task-verified' as const, output: 'tests pass', timestamp: NOW }];
    const wrote = await writeJsonAtomic(String(session.signalsFile), signals);
    if (!wrote.ok) return Result.error(wrote.error);
    return Result.ok({ signalsFile: session.signalsFile, exitCode: 0, sessionId: 'sess-1' });
  },
};

/** Interactive prompt that submits an empty body — review-loop sees an empty round and terminates. */
const terminatingInteractive: InteractivePrompt = {
  async askText() {
    throw new Error('terminatingInteractive: askText not used here');
  },
  async askTextArea() {
    return Result.ok('');
  },
  async askChoice<T>(_p: string, _options: ReadonlyArray<Choice<T>>) {
    void _p;
    void _options;
    throw new Error('terminatingInteractive: askChoice not used here');
  },
  async askMultiChoice<T>(_p: string, _options: ReadonlyArray<Choice<T>>) {
    void _p;
    void _options;
    throw new Error('terminatingInteractive: askMultiChoice not used here');
  },
  async askConfirm(_input: AskConfirmInput) {
    void _input;
    throw new Error('terminatingInteractive: askConfirm not used here');
  },
};

interface FixtureBundle {
  readonly sprint: Sprint;
  readonly execution: SprintExecution;
  readonly tasks: readonly Task[];
  readonly progressFile: string;
  readonly feedbackFile: string;
  readonly dir: string;
}

const buildFixture = async (taskCount = 1): Promise<FixtureBundle> => {
  const ticket = makeApprovedTicket({ title: 'a-ticket' });
  const sprint = makePlannedSprint({ tickets: [ticket] });
  // Pre-set the branch so resolveBranchLeaf takes the resume path (no prompt).
  const execution = setExecutionBranch(createSprintExecution({ sprintId: sprint.id }), 'ralphctl/test');
  const tasks = Array.from({ length: taskCount }, (_, i) =>
    makeTodoTask({
      name: `task-${String(i + 1)}`,
      order: i + 1,
      ticketId: ticket.id,
      repositoryId: FIXED_REPOSITORY_ID,
    })
  );
  const dir = await realpath(await fs.mkdtemp(join(tmpdir(), 'ralphctl-run-')));
  return {
    sprint,
    execution,
    tasks,
    progressFile: join(dir, 'progress.md'),
    feedbackFile: join(dir, 'feedback.md'),
    dir,
  };
};

describe('createRunFlow', () => {
  let cleanups: Array<() => Promise<void>>;
  beforeEach(() => {
    cleanups = [];
  });
  afterEach(async () => {
    for (const c of cleanups) await c();
  });

  it('full implement → review → done arc when noReview=false: sprint ends in done, task is done', async () => {
    const f = await buildFixture(1);
    cleanups.push(async () => {
      await fs.rm(f.dir, { recursive: true, force: true });
    });
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);
    const eventBus = createInMemoryEventBus();
    const harness = createInMemorySink<HarnessSignal>();
    const locker = createFileLocker();
    const locksRoot = absolutePath(f.dir);

    const flow = createRunFlow(
      {
        implement: {
          sprintRepo: sprintRepo.repo,
          sprintExecutionRepo: inMemoryExecutionRepo(f.execution),
          taskRepo: taskRepo.repo,
          generatorProvider: passingProvider,
          evaluatorProvider: passingProvider,
          templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
          signals: harness,
          eventBus,
          logger: noopLogger,
          clock: () => FIXED_LATER,
          config: {
            harness: {
              maxTurns: 3,
              maxAttempts: 3,
              rateLimitRetries: 0,
              plateauThreshold: 2,
              escalateOnPlateau: false,
              escalationMap: {},
            },
          },
          gitRunner: cleanGit,
          shellScriptRunner: passingShell,
          fileLocker: locker,
          locksRoot,
          skillsAdapter: noopSkillsAdapter,
          skillSource: emptySkillSource,
          interactive: terminatingInteractive,
          writeFile: createAtomicWriteFile(),
          appendFile: createAppendFile(),
        },
        review: {
          sprintRepo: sprintRepo.repo,
          taskRepo: taskRepo.repo,
          provider: passingProvider,
          templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
          signals: harness,
          eventBus,
          logger: noopLogger,
          clock: () => FIXED_LATER,
          interactive: terminatingInteractive,
          gitRunner: cleanGit,
          shellScriptRunner: passingShell,
          fileLocker: locker,
          locksRoot,
          appendFile: createAppendFile(),
          model: 'claude-opus-4-8',
        },
      },
      {
        sprintId: f.sprint.id,
        todoTasks: f.tasks,
        repositories: FAKE_REPOSITORIES,
        reviewRoot: absolutePath(join(f.dir, 'review')),
        commitCwd: FAKE_CWD,
        additionalRoots: [FAKE_CWD],
        repositoriesBlock: `- \`${String(FAKE_CWD)}\` (fake-cwd)`,
        progressFile: absolutePath(f.progressFile),
        sprintDir: absolutePath(f.dir),
        feedbackFile: absolutePath(f.feedbackFile),
        model: 'claude-opus-4-8',
        providerId: 'claude-code',
        memoryRoot: FAKE_MEMORY_ROOT,
        projectId: FAKE_PROJECT_ID,
      }
    );

    const runner = createRunner({ id: 'run-default', element: flow, initialCtx: { sprintId: f.sprint.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(taskRepo.tasks()[0]?.status).toBe('done');
    expect(sprintRepo.current().status).toBe('done');
  });

  it('skips review when noReview=true: sprint ends in review, task is done', async () => {
    const f = await buildFixture(1);
    cleanups.push(async () => {
      await fs.rm(f.dir, { recursive: true, force: true });
    });
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);
    const harness = createInMemorySink<HarnessSignal>();
    const eventBus = createInMemoryEventBus();
    const locker = createFileLocker();
    const locksRoot = absolutePath(f.dir);

    const flow = createRunFlow(
      {
        implement: {
          sprintRepo: sprintRepo.repo,
          sprintExecutionRepo: inMemoryExecutionRepo(f.execution),
          taskRepo: taskRepo.repo,
          generatorProvider: passingProvider,
          evaluatorProvider: passingProvider,
          templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
          signals: harness,
          eventBus,
          logger: noopLogger,
          clock: () => FIXED_LATER,
          config: {
            harness: {
              maxTurns: 3,
              maxAttempts: 3,
              rateLimitRetries: 0,
              plateauThreshold: 2,
              escalateOnPlateau: false,
              escalationMap: {},
            },
          },
          gitRunner: cleanGit,
          shellScriptRunner: passingShell,
          fileLocker: locker,
          locksRoot,
          skillsAdapter: noopSkillsAdapter,
          skillSource: emptySkillSource,
          interactive: terminatingInteractive,
          writeFile: createAtomicWriteFile(),
          appendFile: createAppendFile(),
        },
        review: {
          sprintRepo: sprintRepo.repo,
          taskRepo: taskRepo.repo,
          provider: passingProvider,
          templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
          signals: harness,
          eventBus,
          logger: noopLogger,
          clock: () => FIXED_LATER,
          interactive: terminatingInteractive,
          gitRunner: cleanGit,
          shellScriptRunner: passingShell,
          fileLocker: locker,
          locksRoot,
          appendFile: createAppendFile(),
          model: 'claude-opus-4-8',
        },
      },
      {
        sprintId: f.sprint.id,
        todoTasks: f.tasks,
        repositories: FAKE_REPOSITORIES,
        reviewRoot: absolutePath(join(f.dir, 'review')),
        commitCwd: FAKE_CWD,
        additionalRoots: [FAKE_CWD],
        repositoriesBlock: `- \`${String(FAKE_CWD)}\` (fake-cwd)`,
        progressFile: absolutePath(f.progressFile),
        sprintDir: absolutePath(f.dir),
        feedbackFile: absolutePath(f.feedbackFile),
        model: 'claude-opus-4-8',
        providerId: 'claude-code',
        memoryRoot: FAKE_MEMORY_ROOT,
        projectId: FAKE_PROJECT_ID,
        noReview: true,
      }
    );

    const runner = createRunner({ id: 'run-no-review', element: flow, initialCtx: { sprintId: f.sprint.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(taskRepo.tasks()[0]?.status).toBe('done');
    expect(sprintRepo.current().status).toBe('review');
  });
});
