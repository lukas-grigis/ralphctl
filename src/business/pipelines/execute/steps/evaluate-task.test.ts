import { describe, expect, it, vi } from 'vitest';
import type { Config, Sprint, Task } from '@src/domain/models.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { FilesystemPort } from '@src/business/ports/filesystem.ts';
import type { AiSessionPort } from '@src/business/ports/ai-session.ts';
import type { PromptBuilderPort } from '@src/business/ports/prompt-builder.ts';
import type { OutputParserPort } from '@src/business/ports/output-parser.ts';
import type { LoggerPort, SpinnerHandle } from '@src/business/ports/logger.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import type { ExecuteTasksUseCase } from '@src/business/usecases/execute.ts';
import { evaluateTask } from './evaluate-task.ts';

function makeSprint(): Sprint {
  return {
    id: 's1',
    name: 'Sprint',
    projectId: 'proj-1',
    status: 'active',
    createdAt: '',
    activatedAt: null,
    closedAt: null,
    tickets: [],
    checkRanAt: {},
    branch: null,
  };
}

function makeTask(): Task {
  return {
    id: 't1',
    name: 'Task 1',
    steps: [],
    verificationCriteria: [],
    status: 'in_progress',
    order: 1,
    blockedBy: [],
    repoId: 'repo-1',
    verified: true,
    evaluated: false,
  };
}

function makeConfig(iterations: number | undefined = 1): Config {
  return {
    currentSprint: null,
    aiProvider: 'claude',
    editor: null,
    evaluationIterations: iterations,
  };
}

function makeSpinner(): SpinnerHandle {
  return { succeed: () => undefined, fail: () => undefined, stop: () => undefined };
}

function makeLogger(): LoggerPort {
  const logger: LoggerPort = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    success: () => undefined,
    warning: () => undefined,
    tip: () => undefined,
    header: () => undefined,
    separator: () => undefined,
    field: () => undefined,
    card: () => undefined,
    newline: () => undefined,
    dim: () => undefined,
    item: () => undefined,
    spinner: () => makeSpinner(),
    child: () => logger,
    time: () => () => undefined,
  };
  return logger;
}

function makeEmptyStub(): never {
  return {} as never;
}

/**
 * Evaluator renders a "Project Tooling" section from `external.detectProjectTooling()`;
 * tests don't care about the content, just that the method exists.
 */
function makeExternalStub(): ExternalPort {
  return { detectProjectTooling: () => '' } as unknown as ExternalPort;
}

describe('evaluateTask step', () => {
  it('no-ops when evaluation is disabled (iterations=0)', async () => {
    const useCase = {
      getEvaluationConfig: vi.fn(() => Promise.resolve({ enabled: false, iterations: 0 })),
    } as unknown as ExecuteTasksUseCase;

    const spawn = vi.fn();
    const result = await evaluateTask({
      persistence: { getConfig: () => Promise.resolve(makeConfig(0)) } as unknown as PersistencePort,
      fs: makeEmptyStub(),
      aiSession: { ensureReady: () => Promise.resolve(), spawnWithRetry: spawn } as unknown as AiSessionPort,
      promptBuilder: makeEmptyStub(),
      parser: makeEmptyStub(),
      ui: makeEmptyStub(),
      logger: makeLogger(),
      external: makeExternalStub(),
      useCase,
      options: {},
    }).execute({ sprintId: 's1', sprint: makeSprint(), task: makeTask() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.evaluationStepNames).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('runs the nested evaluator pipeline when enabled and exposes inner step names', async () => {
    const task = makeTask();
    const sprint = makeSprint();

    const useCase = {
      getEvaluationConfig: vi.fn(() => Promise.resolve({ enabled: true, iterations: 1 })),
    } as unknown as ExecuteTasksUseCase;

    const persistence: Partial<PersistencePort> = {
      getSprint: vi.fn(() => Promise.resolve(sprint)),
      getTask: vi.fn(() => Promise.resolve(task)),
      getConfig: vi.fn(() => Promise.resolve(makeConfig(1))),
      getTasks: vi.fn(() => Promise.resolve([task])),
      saveTasks: vi.fn(() => Promise.resolve()),
      writeEvaluation: vi.fn(() => Promise.resolve()),
      resolveRepoPath: vi.fn(() => Promise.resolve('/repo')),
      getRepoById: vi.fn(() => Promise.reject(new Error('not configured'))),
    };

    const spawnWithRetry = vi.fn(() =>
      Promise.resolve({ output: '<evaluation-passed>ok</evaluation-passed>', sessionId: 's' })
    );

    const result = await evaluateTask({
      persistence: persistence as PersistencePort,
      fs: { getSprintDir: () => '/tmp' } as unknown as FilesystemPort,
      aiSession: {
        ensureReady: () => Promise.resolve(),
        getProviderName: () => 'claude',
        getSpawnEnv: () => ({}),
        spawnWithRetry,
      } as unknown as AiSessionPort,
      promptBuilder: {
        buildTaskEvaluationPrompt: () => 'prompt',
        buildTaskEvaluationResumePrompt: () => 'resume prompt',
      } as unknown as PromptBuilderPort,
      parser: {
        parseEvaluation: () => ({ status: 'passed', dimensions: [], rawOutput: 'ok' }),
      } as unknown as OutputParserPort,
      ui: makeEmptyStub(),
      logger: makeLogger(),
      external: makeExternalStub(),
      useCase,
      options: {},
    }).execute({
      sprintId: 's1',
      sprint,
      task,
      generatorModel: 'claude-sonnet',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Inner evaluator's step order (from createEvaluatorPipeline):
    //   load-sprint → load-task → check-already-evaluated → run-evaluator-loop
    expect(result.value.evaluationStepNames).toEqual([
      'load-sprint',
      'load-task',
      'check-already-evaluated',
      'run-evaluator-loop',
    ]);
    expect(spawnWithRetry).toHaveBeenCalled();
  });

  it('swallows inner pipeline errors (evaluator is advisory — non-blocking)', async () => {
    const task = makeTask();
    const sprint = makeSprint();

    const useCase = {
      getEvaluationConfig: vi.fn(() => Promise.resolve({ enabled: true, iterations: 1 })),
    } as unknown as ExecuteTasksUseCase;

    // getSprint rejects so the inner pipeline fails at load-sprint — the
    // outer step must STILL return Result.ok so the per-task pipeline
    // proceeds to mark-done. An evaluator that can't run shouldn't stall
    // the sprint.
    const persistence: Partial<PersistencePort> = {
      getSprint: () => Promise.reject(new Error('db down')),
    };

    const result = await evaluateTask({
      persistence: persistence as PersistencePort,
      fs: makeEmptyStub(),
      aiSession: makeEmptyStub(),
      promptBuilder: makeEmptyStub(),
      parser: makeEmptyStub(),
      ui: makeEmptyStub(),
      logger: makeLogger(),
      external: makeExternalStub(),
      useCase,
      options: {},
    }).execute({ sprintId: 's1', sprint, task });

    expect(result.ok).toBe(true);
  });
});
