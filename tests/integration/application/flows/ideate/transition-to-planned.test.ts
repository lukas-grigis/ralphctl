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
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type {
  InteractiveAiProvider,
  InteractiveAiProviderInput,
} from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { absolutePath, makeDraftSprint, makeProject } from '@tests/fixtures/domain.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import { passthroughRunInTerminal } from '@src/application/ui/shared/run-in-terminal.ts';
import { createIdeateFlow } from '@src/application/flows/ideate/flow.ts';
import type { IdeateCtx } from '@src/application/flows/ideate/ctx.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { emptySkillSource, noopSkillsAdapter } from '@tests/fixtures/skills-fakes.ts';

/**
 * Integration fence for change-set M1 — ideate transitions the sprint `draft → planned` so the
 * downstream Implement flow (which requires `planned` / `active`) is reachable right after a
 * successful ideate. The e2e test asserts the persisted repo state; this test asserts the
 * **ctx** sprint mutation produced by the `transition-to-planned` leaf, and that the leaf runs
 * after `ideate-and-plan` (which appends the approved ticket the transition's preconditions
 * depend on).
 */

const FAKE_CWD = absolutePath('/tmp/ralph/fake-cwd');

const inMemorySprintRepo = (initial: Sprint): SprintRepository =>
  ({
    async findById(id: SprintId) {
      if (initial.id === id) return Result.ok(initial);
      return Result.error(new NotFoundError({ entity: 'sprint', id: String(id) }));
    },
    async save() {
      return Result.ok(undefined);
    },
  }) as unknown as SprintRepository;

const inMemoryProjectRepo = (project: Project): ProjectRepository =>
  ({
    async findById(id: ProjectId) {
      if (project.id === id) return Result.ok(project);
      return Result.error(new NotFoundError({ entity: 'project', id: String(id) }));
    },
  }) as ProjectRepository;

const inMemoryTaskRepo = (): TaskRepository =>
  ({
    async findBySprintId() {
      return Result.ok([] as readonly Task[]);
    },
    async saveAll() {
      return Result.ok(undefined);
    },
  }) as unknown as TaskRepository;

const fakeInteractiveAi = (outputJson: string): InteractiveAiProvider => ({
  async run(input: InteractiveAiProviderInput) {
    const envelope = {
      schemaVersion: 1,
      signals: [{ type: 'ideated-tickets', outputJson, timestamp: '2026-05-22T10:00:00.000Z' }],
    };
    await fs.writeFile(String(input.outputFile), JSON.stringify(envelope), 'utf8');
    return Result.ok({});
  },
});

describe('createIdeateFlow — draft → planned transition (M1)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await realpath(await fs.mkdtemp(join(tmpdir(), 'ralphctl-ideate-planned-')));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const ideateRoot = (): AbsolutePath => {
    const r = AbsolutePath.parse(join(dir, 'ideate'));
    if (!r.ok) throw new Error('test setup');
    return r.value;
  };

  it('leaves the ctx sprint as `planned` and runs transition-to-planned after ideate-and-plan', async () => {
    const project = makeProject();
    const sprint = makeDraftSprint();
    const eventBus = createInMemoryEventBus();

    const flow = createIdeateFlow(
      {
        sprintRepo: inMemorySprintRepo(sprint),
        projectRepo: inMemoryProjectRepo(project),
        taskRepo: inMemoryTaskRepo(),
        interactiveAi: fakeInteractiveAi(
          JSON.stringify({
            requirements: '## Problem\n…\n\n## AC\n- given X, when Y, then Z',
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
          })
        ),
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
        ideateRoot: ideateRoot(),
      }
    );

    const runner = createRunner<IdeateCtx>({
      id: 'r-ideate-planned',
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
    // The transition leaf mutated the ctx sprint to `planned` (same domain transition plan uses).
    expect(runner.ctx.sprint?.status).toBe('planned');

    const order = runner.trace.map((s) => s.elementName);
    const ideateIdx = order.indexOf('ideate-and-plan');
    const transitionIdx = order.indexOf('transition-to-planned');
    const saveSprintIdx = order.indexOf('save-sprint');
    expect(transitionIdx).toBeGreaterThan(ideateIdx);
    expect(saveSprintIdx).toBeGreaterThan(transitionIdx);
  });
});
