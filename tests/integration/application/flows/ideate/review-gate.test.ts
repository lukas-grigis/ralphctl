import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type {
  InteractiveAiProvider,
  InteractiveAiProviderInput,
} from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import { absolutePath, makeDraftSprint, makeProject } from '@tests/fixtures/domain.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import { passthroughRunInTerminal } from '@src/integration/io/run-in-terminal.ts';
import { createIdeateFlow } from '@src/application/flows/ideate/flow.ts';
import type { IdeateCtx } from '@src/application/flows/ideate/ctx.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { emptySkillSource, noopSkillsAdapter } from '@tests/fixtures/skills-fakes.ts';
import { inMemorySprintRepo, inMemoryProjectRepo, inMemoryTaskRepo } from '@tests/fixtures/in-memory-repos.ts';

/** Review gate: reject leaves the draft sprint unsaved-as-planned and no tasks written; accept plans it. */
const FAKE_CWD = absolutePath('/tmp/ralph/fake-cwd');

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

describe('createIdeateFlow — review gate', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await realpath(await fs.mkdtemp(join(tmpdir(), 'ralphctl-ideate-review-')));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const run = async (
    reviewBeforeApprove?: (r: string, t: readonly unknown[], f: readonly unknown[]) => Promise<{ accept: boolean }>
  ) => {
    const project = makeProject();
    const sprint = makeDraftSprint();
    const sprintRepo = inMemorySprintRepo(sprint);
    const taskRepo = inMemoryTaskRepo();
    const root = AbsolutePath.parse(join(dir, 'ideate'));
    if (!root.ok) throw new Error('test setup');
    const flow = createIdeateFlow(
      {
        sprintRepo: sprintRepo.repo,
        projectRepo: inMemoryProjectRepo(project),
        taskRepo: taskRepo.repo,
        interactiveAi: fakeInteractiveAi(
          JSON.stringify({
            requirements: '## Problem\nneeds export',
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
        ideaTitle: 'Quick CSV export',
        ideaText: 'Need export.',
        cwd: FAKE_CWD,
        providerId: 'claude-code',
        model: 'claude-sonnet-4-6',
        maxAttempts: 3,
        ideateRoot: root.value,
      }
    );
    const runner = createRunner<IdeateCtx>({
      id: 'r-ideate-review',
      element: flow,
      initialCtx: {
        sprintId: sprint.id,
        projectId: project.id,
        ideaTitle: 'Quick CSV export',
        ideaText: 'Need export.',
        cwd: FAKE_CWD,
      },
    });
    await runner.start();
    return { runner, savedSprints: sprintRepo.saves, savedTasks: taskRepo.saveAlls.flat() };
  };

  it('shows requirements + tasks to the gate, then plans on accept', async () => {
    const seen: Array<{ req: string; tasks: number; findings: number }> = [];
    const { runner, savedTasks } = await run(async (req, tasks, findings) => {
      seen.push({ req, tasks: tasks.length, findings: findings.length });
      return { accept: true };
    });
    expect(runner.status).toBe('completed');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.req).toContain('needs export');
    expect(seen[0]?.tasks).toBe(1);
    expect(runner.ctx.planCheck).toBeDefined();
    expect(runner.ctx.sprint?.status).toBe('planned');
    expect(savedTasks).toHaveLength(1);
  });

  it('on reject restores the draft sprint, adds no tickets/tasks and skips the transition', async () => {
    const { runner, savedTasks, savedSprints } = await run(async () => ({ accept: false }));
    expect(runner.status).toBe('completed');
    expect(runner.ctx.ideateRejected).toBe(true);
    expect(runner.ctx.sprint?.status).toBe('draft');
    expect(runner.ctx.sprint?.tickets).toHaveLength(0);
    expect(savedTasks).toHaveLength(0);
    expect(savedSprints.every((s) => s.status === 'draft' && s.tickets.length === 0)).toBe(true);
  });
});
