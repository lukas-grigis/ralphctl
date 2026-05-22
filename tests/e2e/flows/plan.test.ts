import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import { addTicket, type Sprint } from '@src/domain/entity/sprint.ts';
import { approveTicketRequirements } from '@src/domain/entity/ticket.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type {
  InteractiveAiProvider,
  InteractiveAiProviderInput,
} from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { FIXED_LATER, makeDraftSprint, makeExecution, makePendingTicket, makeProject } from '@tests/fixtures/domain.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import { passthroughRunInTerminal } from '@src/application/ui/shared/run-in-terminal.ts';
import { createPlanFlow } from '@src/application/flows/plan/flow.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { emptySkillSource, noopSkillsAdapter } from '@tests/fixtures/skills-fakes.ts';

const inMemorySprintRepo = (initial: Sprint): { repo: SprintRepository; current: () => Sprint } => {
  let current = initial;
  const repo = {
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

const inMemoryProjectRepo = (project: Project): ProjectRepository =>
  ({
    async findById(id: ProjectId) {
      if (project.id === id) return Result.ok(project);
      return Result.error(new NotFoundError({ entity: 'project', id: String(id) }));
    },
  }) as ProjectRepository;

const inMemoryExecutionRepo = (execution: SprintExecution): SprintExecutionRepository =>
  ({
    async findById(id: SprintId) {
      if (execution.sprintId === id) return Result.ok(execution);
      return Result.error(new NotFoundError({ entity: 'execution', id: String(id) }));
    },
  }) as SprintExecutionRepository;

const inMemoryTaskRepo = (initial: readonly Task[]): { repo: TaskRepository; tasks: () => readonly Task[] } => {
  let store: Task[] = [...initial];
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
      store = [...tasks];
      return Result.ok(undefined);
    },
  } as TaskRepository;
  return { repo, tasks: () => store };
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
      // audit-[09]: wrap the responder's JSON in a `task-plan` signal envelope so the contract
      // validation succeeds end-to-end.
      const envelope = {
        schemaVersion: 1,
        signals: [{ type: 'task-plan', tasksJson: jsonResponder(input), timestamp: '2026-05-22T10:00:00.000Z' }],
      };
      await fs.writeFile(String(input.outputFile), JSON.stringify(envelope), 'utf8');
      return Result.ok({});
    },
  };
  return { session, calls };
};

/** Build a draft sprint with N approved tickets, return sprint + ticket ids in order. */
const draftWithApproved = (count: number): { sprint: Sprint; ticketIds: string[] } => {
  let sprint: Sprint = makeDraftSprint();
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const pending = makePendingTicket({ title: `Ticket ${i + 1}` });
    const added = addTicket(sprint, pending);
    if (!added.ok) throw new Error('addTicket failed');
    const approved = approveTicketRequirements(added.value.tickets[i]!, '## requirements\n');
    if (!approved.ok) throw new Error('approve failed');
    sprint = {
      ...added.value,
      tickets: added.value.tickets.map((t, idx) => (idx === i ? approved.value : t)),
    };
    ids.push(String(approved.value.id));
  }
  return { sprint, ticketIds: ids };
};

describe('createPlanFlow — interactive', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await realpath(await fs.mkdtemp(join(tmpdir(), 'ralphctl-plan-')));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const planRoot = (): AbsolutePath => {
    const r = AbsolutePath.parse(join(dir, 'plan'));
    if (!r.ok) throw new Error('test setup');
    return r.value;
  };

  const buildDeps = (
    sprintRepo: SprintRepository,
    project: Project,
    sprint: Sprint,
    taskRepo: TaskRepository,
    ai: InteractiveAiProvider
  ): Parameters<typeof createPlanFlow>[0] => ({
    sprintRepo,
    sprintExecutionRepo: inMemoryExecutionRepo(makeExecution(sprint.id)),
    projectRepo: inMemoryProjectRepo(project),
    taskRepo,
    interactiveAi: ai,
    templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
    writeFile: createAtomicWriteFile(),
    runInTerminal: passthroughRunInTerminal,
    eventBus: createInMemoryEventBus(),
    logger: noopLogger,
    clock: () => FIXED_LATER,
    skillsAdapter: noopSkillsAdapter,
    skillSource: emptySkillSource,
  });

  it('happy path: AI emits valid task array, sprint transitions to planned, tasks persisted', async () => {
    const project = makeProject();
    const { sprint, ticketIds } = draftWithApproved(2);
    const sprintRepo = inMemorySprintRepo(sprint);
    const taskRepo = inMemoryTaskRepo([]);

    const fake = fakeInteractiveAi(() =>
      JSON.stringify([
        {
          id: 'T1',
          name: 'Add CSV utility',
          ticketRef: ticketIds[0],
          projectPath: String(project.repositories[0]?.path),
          steps: ['create util', 'write tests'],
          verificationCriteria: ['util exported', 'tests pass'],
        },
        {
          id: 'T2',
          name: 'Wire UI button',
          ticketRef: ticketIds[1],
          projectPath: String(project.repositories[0]?.path),
          steps: ['add button', 'wire handler'],
          verificationCriteria: ['button visible', 'click triggers download'],
          blockedBy: ['T1'],
        },
      ])
    );

    const flow = createPlanFlow(buildDeps(sprintRepo.repo, project, sprint, taskRepo.repo, fake.session), {
      sprintId: sprint.id,
      projectId: project.id,
      model: 'claude-opus-4-7',
      planRoot: planRoot(),
    });

    const runner = createRunner({
      id: 'r-plan',
      element: flow,
      initialCtx: { sprintId: sprint.id, projectId: project.id },
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(fake.calls).toHaveLength(1);
    expect(sprintRepo.current().status).toBe('planned');
    expect(taskRepo.tasks()).toHaveLength(2);
    expect(taskRepo.tasks()[0]?.name).toBe('Add CSV utility');
    expect(taskRepo.tasks()[1]?.dependsOn).toHaveLength(1);
  });

  it('halts when AI emits {"blocked": "..."} — sprint stays draft, no tasks', async () => {
    const project = makeProject();
    const { sprint } = draftWithApproved(1);
    const sprintRepo = inMemorySprintRepo(sprint);
    const taskRepo = inMemoryTaskRepo([]);

    const fake = fakeInteractiveAi(() => JSON.stringify({ blocked: 'requirements contradict each other' }));

    const flow = createPlanFlow(buildDeps(sprintRepo.repo, project, sprint, taskRepo.repo, fake.session), {
      sprintId: sprint.id,
      projectId: project.id,
      model: 'claude-opus-4-7',
      planRoot: planRoot(),
    });
    const runner = createRunner({
      id: 'r-plan-blocked',
      element: flow,
      initialCtx: { sprintId: sprint.id, projectId: project.id },
    });
    await runner.start();

    expect(runner.status).toBe('failed');
    expect(sprintRepo.current().status).toBe('draft');
    expect(taskRepo.tasks()).toHaveLength(0);
  });

  it('halts when AI references an unknown ticketRef — sprint untouched', async () => {
    const project = makeProject();
    const { sprint } = draftWithApproved(1);
    const sprintRepo = inMemorySprintRepo(sprint);
    const taskRepo = inMemoryTaskRepo([]);

    const fake = fakeInteractiveAi(() =>
      JSON.stringify([
        {
          id: 'T1',
          name: 'X',
          ticketRef: '00000000-0000-7000-8000-000000000000',
          projectPath: String(project.repositories[0]?.path),
          steps: ['s'],
          verificationCriteria: ['v'],
        },
      ])
    );

    const flow = createPlanFlow(buildDeps(sprintRepo.repo, project, sprint, taskRepo.repo, fake.session), {
      sprintId: sprint.id,
      projectId: project.id,
      model: 'claude-opus-4-7',
      planRoot: planRoot(),
    });
    const runner = createRunner({
      id: 'r-plan-unknown',
      element: flow,
      initialCtx: { sprintId: sprint.id, projectId: project.id },
    });
    await runner.start();

    expect(runner.status).toBe('failed');
    expect(sprintRepo.current().status).toBe('draft');
    expect(taskRepo.tasks()).toHaveLength(0);
  });
});
