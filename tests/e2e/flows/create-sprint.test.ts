import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type { Choice, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { FIXED_NOW, FIXED_PROJECT_ID, makeProject } from '@tests/fixtures/domain.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import { createCreateSprintFlow } from '@src/application/flows/create-sprint/flow.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { recordingAppendFile } from '@tests/fixtures/recording-append-file.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';

const fakeProjectRepo = (project: Project | undefined): ProjectRepository =>
  ({
    async findById(id: ProjectId) {
      if (project && project.id === id) return Result.ok(project);
      return Result.error(new NotFoundError({ entity: 'project', id: String(id) }));
    },
  }) as ProjectRepository;

const inMemorySprintRepo = (): { repo: SprintRepository; saves: Sprint[] } => {
  const saves: Sprint[] = [];
  const repo = {
    async save(sprint: Sprint) {
      saves.push(sprint);
      return Result.ok(undefined);
    },
  } as SprintRepository;
  return { repo, saves };
};

const inMemorySprintExecutionRepo = (): {
  repo: SprintExecutionRepository;
  saves: SprintExecution[];
} => {
  const saves: SprintExecution[] = [];
  const repo = {
    async save(execution: SprintExecution) {
      saves.push(execution);
      return Result.ok(undefined);
    },
  } as SprintExecutionRepository;
  return { repo, saves };
};

interface ScriptedFailure {
  readonly on: 'text';
  readonly error: DomainError;
}

const scriptedPrompt = (texts: readonly string[], failure?: ScriptedFailure): InteractivePrompt => {
  let textIdx = 0;
  return {
    async askText(_prompt: string) {
      void _prompt;
      if (failure?.on === 'text') return Result.error(failure.error);
      const v = texts[textIdx++];
      if (v === undefined) throw new Error('scriptedPrompt: ran out of text answers');
      return Result.ok(v);
    },
    async askTextArea(_prompt: string) {
      void _prompt;
      throw new Error('scriptedPrompt: askTextArea not scripted for this test');
    },
    async askChoice<T>(_prompt: string, _options: ReadonlyArray<Choice<T>>) {
      void _prompt;
      void _options;
      throw new Error('scriptedPrompt: askChoice not scripted for this test');
    },
    async askMultiChoice<T>(_prompt: string, _options: ReadonlyArray<Choice<T>>) {
      void _prompt;
      void _options;
      throw new Error('scriptedPrompt: askMultiChoice not scripted for this test');
    },
    async askConfirm() {
      throw new Error('scriptedPrompt: askConfirm not scripted for this test');
    },
  };
};

describe('createCreateSprintFlow', () => {
  it('walks the full chain — load project, ask name, create, save sprint + execution', async () => {
    const project = makeProject();
    const projectRepo = fakeProjectRepo(project);
    const sprint = inMemorySprintRepo();
    const exec = inMemorySprintExecutionRepo();
    const prompt = scriptedPrompt(['kickoff']);

    const flow = createCreateSprintFlow({
      projectRepo,
      sprintRepo: sprint.repo,
      sprintExecutionRepo: exec.repo,
      interactive: prompt,
      clock: () => FIXED_NOW,
      eventBus: createInMemoryEventBus(),
      logger: noopLogger,
      appendFile: recordingAppendFile().fn,
      dataRoot: absolutePath('/tmp/ralph-tests'),
    });

    const runner = createRunner({ id: 'r-create-1', element: flow, initialCtx: { projectId: project.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(runner.trace.map((e) => e.elementName)).toEqual([
      'load-project',
      'interactive-sprint-name',
      'create-sprint',
      'save-sprint',
      'save-sprint-execution',
      'init-progress-journal',
    ]);
    expect(sprint.saves).toHaveLength(1);
    expect(sprint.saves[0]?.name).toBe('kickoff');
    expect(sprint.saves[0]?.status).toBe('draft');
    expect(sprint.saves[0]?.projectId).toBe(project.id);

    expect(exec.saves).toHaveLength(1);
    expect(exec.saves[0]?.sprintId).toBe(sprint.saves[0]?.id);
    expect(exec.saves[0]?.branch).toBeNull();
    expect(exec.saves[0]?.setupRanAt).toEqual([]);
  });

  it('fails fast when the project is not found — load-project surfaces NotFoundError, downstream is skipped', async () => {
    const projectRepo = fakeProjectRepo(undefined);
    const sprint = inMemorySprintRepo();
    const exec = inMemorySprintExecutionRepo();
    const prompt = scriptedPrompt([]);

    const flow = createCreateSprintFlow({
      projectRepo,
      sprintRepo: sprint.repo,
      sprintExecutionRepo: exec.repo,
      interactive: prompt,
      clock: () => FIXED_NOW,
      eventBus: createInMemoryEventBus(),
      logger: noopLogger,
      appendFile: recordingAppendFile().fn,
      dataRoot: absolutePath('/tmp/ralph-tests'),
    });

    const runner = createRunner({
      id: 'r-create-missing',
      element: flow,
      initialCtx: { projectId: FIXED_PROJECT_ID },
    });
    await runner.start();

    expect(runner.status).toBe('failed');
    const trace = runner.trace.map((e) => `${e.elementName}:${e.status}`);
    expect(trace).toEqual([
      'load-project:failed',
      'interactive-sprint-name:skipped',
      'create-sprint:skipped',
      'save-sprint:skipped',
      'save-sprint-execution:skipped',
      'init-progress-journal:skipped',
    ]);
    expect(sprint.saves).toHaveLength(0);
    expect(exec.saves).toHaveLength(0);
    const failed = runner.trace.find((e) => e.status === 'failed');
    expect(failed?.error).toBeInstanceOf(NotFoundError);
  });

  it('derives the slug from the kebab-cased name when no explicit slug is provided', async () => {
    const project = makeProject();
    const projectRepo = fakeProjectRepo(project);
    const sprint = inMemorySprintRepo();
    const exec = inMemorySprintExecutionRepo();
    const prompt = scriptedPrompt(['Release Plan']);

    const flow = createCreateSprintFlow({
      projectRepo,
      sprintRepo: sprint.repo,
      sprintExecutionRepo: exec.repo,
      interactive: prompt,
      clock: () => FIXED_NOW,
      eventBus: createInMemoryEventBus(),
      logger: noopLogger,
      appendFile: recordingAppendFile().fn,
      dataRoot: absolutePath('/tmp/ralph-tests'),
    });

    const runner = createRunner({ id: 'r-create-slug', element: flow, initialCtx: { projectId: project.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(sprint.saves[0]?.name).toBe('Release Plan');
    expect(String(sprint.saves[0]?.slug)).toBe('release-plan');
  });
});
