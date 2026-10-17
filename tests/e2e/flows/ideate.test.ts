import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import { planSprint, type Sprint } from '@src/domain/entity/sprint.ts';
import { ConflictError } from '@src/domain/value/error/conflict-error.ts';
import type { IdeateCtx } from '@src/application/flows/ideate/ctx.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type {
  InteractiveAiProvider,
  InteractiveAiProviderInput,
} from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import {
  absolutePath,
  FIXED_LATER,
  makeApprovedTicket,
  makeDraftSprint,
  makeProject,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { createRunner, type Runner } from '@src/application/chain/run/runner.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import { passthroughRunInTerminal } from '@src/application/ui/shared/run-in-terminal.ts';
import { createIdeateFlow } from '@src/application/flows/ideate/flow.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { emptySkillSource, noopSkillsAdapter } from '@tests/fixtures/skills-fakes.ts';
import { withUpdate } from '@tests/fixtures/sprint-repo-update.ts';

const FAKE_CWD = absolutePath('/tmp/ralph/fake-cwd');

const inMemorySprintRepo = (initial: Sprint): { repo: SprintRepository; current: () => Sprint } => {
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

const inMemoryProjectRepo = (project: Project): ProjectRepository =>
  ({
    async findById(id: ProjectId) {
      if (project.id === id) return Result.ok(project);
      return Result.error(new NotFoundError({ entity: 'project', id: String(id) }));
    },
  }) as ProjectRepository;

const inMemoryTaskRepo = (
  initial: readonly Task[]
): { repo: TaskRepository; tasks: () => readonly Task[]; writes: () => ReadonlyArray<readonly Task[]> } => {
  let store: Task[] = [...initial];
  const writes: Array<readonly Task[]> = [];
  const repo = {
    async findBySprintId() {
      return Result.ok(store);
    },
    async findById(_: SprintId, taskId: Task['id']) {
      const t = store.find((x) => x.id === taskId);
      if (!t) return Result.error(new NotFoundError({ entity: 'task', id: String(taskId) }));
      return Result.ok(t);
    },
    async update(_: SprintId, task: Task) {
      const i = store.findIndex((x) => x.id === task.id);
      if (i >= 0) store[i] = task;
      else store = [...store, task];
      return Result.ok(undefined);
    },
    async saveAll(_: SprintId, tasks: readonly Task[]) {
      writes.push(tasks);
      store = [...tasks];
      return Result.ok(undefined);
    },
  } as TaskRepository;
  return { repo, tasks: () => store, writes: () => writes };
};

const fakeInteractiveAi = (
  jsonResponder: (input: InteractiveAiProviderInput) => string
): {
  session: InteractiveAiProvider;
  calls: Array<{ input: InteractiveAiProviderInput; promptBody: string }>;
} => {
  const calls: Array<{ input: InteractiveAiProviderInput; promptBody: string }> = [];
  const session: InteractiveAiProvider = {
    async run(input) {
      const promptBody = await fs.readFile(String(input.promptFile), 'utf8');
      calls.push({ input, promptBody });
      // audit-[09]: wrap the responder's JSON in an `ideated-tickets` signal envelope so the
      // contract validation succeeds end-to-end.
      const envelope = {
        schemaVersion: 1,
        signals: [{ type: 'ideated-tickets', outputJson: jsonResponder(input), timestamp: '2026-05-22T10:00:00.000Z' }],
      };
      await fs.writeFile(String(input.outputFile), JSON.stringify(envelope), 'utf8');
      return Result.ok({});
    },
  };
  return { session, calls };
};

describe('createIdeateFlow', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await realpath(await fs.mkdtemp(join(tmpdir(), 'ralphctl-ideate-')));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const ideateRoot = (): AbsolutePath => {
    const r = AbsolutePath.parse(join(dir, 'ideate'));
    if (!r.ok) throw new Error('test setup');
    return r.value;
  };

  it('produces a ticket + tasks, persists both, transitions sprint draft → planned', async () => {
    const project = makeProject();
    const sprint = makeDraftSprint();
    const sprintRepo = inMemorySprintRepo(sprint);
    const projectRepo = inMemoryProjectRepo(project);
    const taskRepo = inMemoryTaskRepo([]);
    const eventBus = createInMemoryEventBus();

    const fake = fakeInteractiveAi(() =>
      JSON.stringify({
        requirements: '## Problem\n…\n\n## AC\n- given X, when Y, then Z',
        tasks: [
          {
            id: '1',
            name: 'Add export button',
            description: 'place it under the table',
            projectPath: String(project.repositories[0]?.path),
            steps: ['create component', 'wire to API'],
            verificationCriteria: [
              { id: 'C1', assertion: 'button visible', check: 'manual' },
              { id: 'C2', assertion: 'click triggers download', check: 'manual' },
            ],
            blockedBy: [],
          },
          {
            id: '2',
            name: 'Add API endpoint',
            projectPath: String(project.repositories[0]?.path),
            steps: ['add route', 'serialize CSV'],
            verificationCriteria: [{ id: 'C1', assertion: 'endpoint returns 200 with CSV body', check: 'manual' }],
            blockedBy: ['1'],
          },
        ],
      })
    );

    const flow = createIdeateFlow(
      {
        sprintRepo: sprintRepo.repo,
        projectRepo,
        taskRepo: taskRepo.repo,
        interactiveAi: fake.session,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        writeFile: createAtomicWriteFile(),
        runInTerminal: passthroughRunInTerminal,
        eventBus,
        logger: noopLogger,
        skillsAdapter: noopSkillsAdapter,
        skillSource: emptySkillSource,
        clock: () => '2026-01-01T00:00:00Z' as IsoTimestamp,
      },
      {
        sprintId: sprint.id,
        projectId: project.id,
        ideaTitle: 'Quick CSV export',
        ideaText: 'Need to let users download their data.',
        cwd: FAKE_CWD,
        providerId: 'claude-code',
        model: 'claude-sonnet-4-6',
        maxAttempts: 3,
        ideateRoot: ideateRoot(),
      }
    );

    const runner = createRunner({
      id: 'r-ideate',
      element: flow,
      initialCtx: {
        sprintId: sprint.id,
        projectId: project.id,
        ideaTitle: 'Quick CSV export',
        ideaText: 'Need to let users download their data.',
        cwd: FAKE_CWD,
      },
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.promptBody).toContain('Quick CSV export');
    expect(fake.calls[0]?.promptBody).toContain(String(project.repositories[0]?.path));

    // Sprint transitions draft → planned (so Implement is reachable right after), and has the
    // new approved ticket appended.
    const finalSprint = sprintRepo.current();
    expect(finalSprint.status).toBe('planned');
    expect(finalSprint.tickets).toHaveLength(1);
    expect(finalSprint.tickets[0]?.title).toBe('Quick CSV export');
    expect(finalSprint.tickets[0]?.status).toBe('approved');

    // The ctx sprint is the transitioned `planned` sprint, and the transition leaf runs after
    // ideate-and-plan and before the save leaves (sequential flattens the load-and-assert
    // sub-chain into its leaf names).
    expect(runner.ctx.sprint?.status).toBe('planned');
    const stepOrder = runner.trace.map((s) => s.elementName);
    expect(stepOrder).toEqual([
      'load-sprint',
      'assert-sprint-status',
      'load-project',
      'load-tasks',
      'build-ideate-unit',
      'render-prompt-to-file',
      'install-skills',
      'stamp-meta-ideate',
      'ideate-and-plan',
      'uninstall-skills',
      'check-plan',
      'review-ideate',
      'transition-to-planned',
      'assert-tickets-unchanged',
      'save-tasks',
      'save-sprint',
    ]);

    // Tasks persisted (both new tasks).
    expect(taskRepo.tasks()).toHaveLength(2);
    expect(taskRepo.tasks()[0]?.name).toBe('Add export button');
    expect(taskRepo.tasks()[1]?.name).toBe('Add API endpoint');
    expect(taskRepo.tasks()[1]?.dependsOn).toHaveLength(1);
  });

  it('halts the chain when AI writes malformed JSON', async () => {
    const project = makeProject();
    const sprint = makeDraftSprint();
    const sprintRepo = inMemorySprintRepo(sprint);
    const projectRepo = inMemoryProjectRepo(project);
    const taskRepo = inMemoryTaskRepo([]);
    const eventBus = createInMemoryEventBus();

    const fake = fakeInteractiveAi(() => 'not json at all');

    const flow = createIdeateFlow(
      {
        sprintRepo: sprintRepo.repo,
        projectRepo,
        taskRepo: taskRepo.repo,
        interactiveAi: fake.session,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        writeFile: createAtomicWriteFile(),
        runInTerminal: passthroughRunInTerminal,
        eventBus,
        logger: noopLogger,
        skillsAdapter: noopSkillsAdapter,
        skillSource: emptySkillSource,
        clock: () => '2026-01-01T00:00:00Z' as IsoTimestamp,
      },
      {
        sprintId: sprint.id,
        projectId: project.id,
        ideaTitle: 'Bad JSON',
        ideaText: 'whatever',
        cwd: FAKE_CWD,
        providerId: 'claude-code',
        model: 'claude-sonnet-4-6',
        maxAttempts: 3,
        ideateRoot: ideateRoot(),
      }
    );
    const runner = createRunner({
      id: 'r-ideate-bad',
      element: flow,
      initialCtx: {
        sprintId: sprint.id,
        projectId: project.id,
        ideaTitle: 'Bad JSON',
        ideaText: 'whatever',
        cwd: FAKE_CWD,
      },
    });
    await runner.start();
    expect(runner.status).toBe('failed');
    // Sprint untouched.
    expect(sprintRepo.current().tickets).toHaveLength(0);
    expect(taskRepo.tasks()).toHaveLength(0);
  });

  describe('another session plans the sprint while this one is ideating', () => {
    const IDEA = { ideaTitle: 'Quick CSV export', ideaText: 'Need to let users download their data.' };

    const run = async (
      reviewBeforeApprove?: () => Promise<{ readonly accept: boolean }>
    ): Promise<{
      runner: Runner<IdeateCtx>;
      sprintRepo: ReturnType<typeof inMemorySprintRepo>;
      taskRepo: ReturnType<typeof inMemoryTaskRepo>;
      theirs: Task;
    }> => {
      const project = makeProject();
      const sprint = makeDraftSprint({ tickets: [makeApprovedTicket()] });
      const sprintRepo = inMemorySprintRepo(sprint);
      const taskRepo = inMemoryTaskRepo([]);
      const theirs = makeTodoTask({ name: 'planned by the other session' });
      const fake = fakeInteractiveAi(() => {
        // A plan run in another terminal commits — tasks first, then the sprint — while ideate is open.
        const planned = planSprint(sprintRepo.current(), FIXED_LATER);
        if (!planned.ok) throw new Error(planned.error.message);
        void taskRepo.repo.saveAll(sprint.id, [theirs]);
        void sprintRepo.repo.save(planned.value);
        return JSON.stringify({
          requirements: '## Problem\n…',
          tasks: [
            {
              id: '1',
              name: 'Add export button',
              projectPath: String(project.repositories[0]?.path),
              steps: ['create component'],
              verificationCriteria: [{ id: 'C1', assertion: 'button visible', check: 'manual' }],
              blockedBy: [],
            },
          ],
        });
      });
      const flow = createIdeateFlow(
        {
          sprintRepo: sprintRepo.repo,
          projectRepo: inMemoryProjectRepo(project),
          taskRepo: taskRepo.repo,
          interactiveAi: fake.session,
          templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
          writeFile: createAtomicWriteFile(),
          runInTerminal: passthroughRunInTerminal,
          eventBus: createInMemoryEventBus(),
          logger: noopLogger,
          skillsAdapter: noopSkillsAdapter,
          skillSource: emptySkillSource,
          clock: () => '2026-01-01T00:00:00Z' as IsoTimestamp,
          ...(reviewBeforeApprove !== undefined ? { reviewBeforeApprove } : {}),
        },
        {
          sprintId: sprint.id,
          projectId: project.id,
          ...IDEA,
          cwd: FAKE_CWD,
          providerId: 'claude-code',
          model: 'claude-sonnet-4-6',
          maxAttempts: 3,
          ideateRoot: ideateRoot(),
        }
      );
      const runner = createRunner<IdeateCtx>({
        id: 'r-ideate-concurrent-plan',
        element: flow,
        initialCtx: { sprintId: sprint.id, projectId: project.id, ...IDEA, cwd: FAKE_CWD },
      });
      await runner.start();
      return { runner, sprintRepo, taskRepo, theirs };
    };

    it('accepted: refuses before the task write — the other plan survives', async () => {
      const { runner, sprintRepo, taskRepo, theirs } = await run();

      expect(runner.status).toBe('failed');
      const assertEntry = runner.trace.find((e) => e.elementName === 'assert-tickets-unchanged');
      expect(assertEntry?.status).toBe('failed');
      expect(assertEntry?.error).toBeInstanceOf(ConflictError);
      for (const name of ['save-tasks', 'save-sprint']) {
        expect(runner.trace.find((e) => e.elementName === name)?.status).toBe('skipped');
      }
      expect(sprintRepo.current().status).toBe('planned');
      expect(sprintRepo.current().tickets).toHaveLength(1);
      expect(taskRepo.writes()).toEqual([[theirs]]);
    });

    it('rejected: writes neither file — the other plan survives', async () => {
      const { runner, sprintRepo, taskRepo, theirs } = await run(async () => ({ accept: false }));

      expect(runner.status).toBe('completed');
      expect(sprintRepo.current().status).toBe('planned');
      expect(taskRepo.writes()).toEqual([[theirs]]);
      expect(taskRepo.tasks()).toEqual([theirs]);
    });
  });
});
