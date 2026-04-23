/**
 * Seeded-flaw regression for the evaluator contract.
 *
 * This test file exists to prove two things the rest of the suite does not:
 *
 * 1. The parser classifies a recorded "flawed-artifact" evaluator output as
 *    `status: 'failed'` with a critique that still references the seeded
 *    flaw — so a future change to the dimension regex or signal handling
 *    can't silently wash real critique out.
 *
 * 2. `EvaluateTaskUseCase.execute()` routes that failed critique back into
 *    the generator via `resumeGeneratorWithCritique` (the private helper at
 *    `evaluate.ts:351-385`) at least once, and the iteration sidecar at
 *    `<sprintDir>/evaluations/<taskId>.md` records the feedback-applied
 *    iteration. The counterpart "clean artifact" case proves the loop does
 *    NOT fire a fix iteration when the evaluator returns
 *    `<evaluation-passed>` with per-dimension justifications.
 *
 * We follow the in-memory stub pattern from `src/business/pipelines/evaluate.test.ts`
 * so the wiring here stays close to the existing fixtures.
 */

import { describe, expect, it } from 'vitest';
import type { Config, Sprint, Task } from '@src/domain/models.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { FilesystemPort } from '@src/business/ports/filesystem.ts';
import type { AiSessionPort, SessionResult } from '@src/business/ports/ai-session.ts';
import type { PromptBuilderPort } from '@src/business/ports/prompt-builder.ts';
import type { EvaluationParseResult, OutputParserPort } from '@src/business/ports/output-parser.ts';
import type { UserInteractionPort } from '@src/business/ports/user-interaction.ts';
import type { LoggerPort, SpinnerHandle } from '@src/business/ports/logger.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import { parseEvaluationResult } from '@src/integration/ai/evaluator.ts';
import { EvaluateTaskUseCase } from './evaluate.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The seeded flaw text — appears verbatim in the recorded evaluator output
 * and must survive into the critique that the parser emits and that the
 * generator-resume prompt carries back to the AI.
 */
const SEEDED_FLAW = 'off-by-one in paginate() — returns items 1..n instead of 0..n-1';

const EVALUATOR_FAILED_OUTPUT = [
  '## Assessment',
  '',
  `**Correctness**: FAIL — ${SEEDED_FLAW}`,
  '**Completeness**: PASS — every declared step landed; generator committed once',
  '**Safety**: PASS — no new input paths, existing validation still applies',
  '**Consistency**: PASS — helper follows the sibling list-utils layout',
  '',
  `<evaluation-failed>${SEEDED_FLAW}</evaluation-failed>`,
].join('\n');

const EVALUATOR_PASSED_OUTPUT = [
  '## Assessment',
  '',
  '**Correctness**: PASS — paginate() now returns items 0..n-1; unit test added at src/list.test.ts:42',
  '**Completeness**: PASS — every step in the task context was implemented',
  '**Safety**: PASS — input is validated by Zod before reaching the slicer',
  '**Consistency**: PASS — matches the existing `list-utils.ts` naming convention',
  '',
  '<evaluation-passed>',
].join('\n');

// ---------------------------------------------------------------------------
// Stub factories — minimal surface needed for `execute()`.
// ---------------------------------------------------------------------------

function makeSprint(overrides: Partial<Sprint> = {}): Sprint {
  return {
    id: 'test-sprint',
    name: 'Seeded-flaw sprint',
    projectId: 'proj-1',
    status: 'active',
    createdAt: new Date().toISOString(),
    activatedAt: new Date().toISOString(),
    closedAt: null,
    tickets: [],
    checkRanAt: {},
    branch: null,
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    name: 'Fix paginate() off-by-one',
    steps: [],
    verificationCriteria: [],
    status: 'done',
    order: 1,
    blockedBy: [],
    repoId: 'repo-1',
    verified: true,
    evaluated: false,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    currentSprint: null,
    aiProvider: 'claude',
    editor: null,
    evaluationIterations: 1,
    ...overrides,
  };
}

function makeSpinner(): SpinnerHandle {
  return {
    succeed: () => {
      /* noop */
    },
    fail: () => {
      /* noop */
    },
    stop: () => {
      /* noop */
    },
  };
}

function makeLogger(): LoggerPort {
  const logger: LoggerPort = {
    debug: () => {
      /* noop */
    },
    info: () => {
      /* noop */
    },
    warn: () => {
      /* noop */
    },
    error: () => {
      /* noop */
    },
    success: () => {
      /* noop */
    },
    warning: () => {
      /* noop */
    },
    tip: () => {
      /* noop */
    },
    header: () => {
      /* noop */
    },
    separator: () => {
      /* noop */
    },
    field: () => {
      /* noop */
    },
    card: () => {
      /* noop */
    },
    newline: () => {
      /* noop */
    },
    dim: () => {
      /* noop */
    },
    item: () => {
      /* noop */
    },
    spinner: () => makeSpinner(),
    child: () => logger,
    time: () => () => {
      /* noop */
    },
  };
  return logger;
}

function makeFs(): FilesystemPort {
  return {
    getSprintDir: () => '/tmp/sprint',
  } as unknown as FilesystemPort;
}

function makeExternal(): ExternalPort {
  return {
    detectProjectTooling: () => '',
  } as unknown as ExternalPort;
}

function makeUi(): UserInteractionPort {
  return {} as UserInteractionPort;
}

/**
 * Mapped `EvaluationParseResult` view of a recorded fixture — mirrors what
 * `DefaultOutputParserAdapter.parseEvaluation` would return, without pulling
 * the adapter into this test. Keeps the parser and use-case stubs independent.
 */
function toParseResult(raw: string): EvaluationParseResult {
  const parsed = parseEvaluationResult(raw);
  return {
    status: parsed.status,
    dimensions: parsed.dimensions.map((d) => ({
      dimension: d.dimension,
      status: d.passed ? 'PASS' : 'FAIL',
      description: d.finding,
    })),
    rawOutput: parsed.output,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseEvaluationResult — seeded-flaw fixture', () => {
  it('classifies the recorded failed output as status=failed with critique carrying the seeded flaw', () => {
    const result = parseEvaluationResult(EVALUATOR_FAILED_OUTPUT);
    expect(result.status).toBe('failed');
    expect(result.passed).toBe(false);
    expect(result.output).toContain(SEEDED_FLAW);
    // Correctness dimension is the single failing one; the rest pass with a
    // justification so the anti-rubber-stamp rule does not flip them.
    const correctness = result.dimensions.find((d) => d.dimension === 'correctness');
    expect(correctness).toBeDefined();
    expect(correctness?.passed).toBe(false);
  });
});

describe('EvaluateTaskUseCase — seeded-flaw fix loop', () => {
  it('routes the failed critique back into a generator fix iteration and records the sidecar entry', async () => {
    const sprint = makeSprint();
    const task = makeTask();

    // Spawn log — lets us assert that a generator-resume spawn carried the
    // critique verbatim. The use case calls `spawnWithRetry` for each
    // evaluator spawn AND for the generator resume; the resume prompt is the
    // only one that contains the "## Evaluator Critique" header string
    // declared at `evaluate.ts:359-364`.
    const spawnPrompts: string[] = [];

    // Recorded evaluator outputs: failed → (resume) → passed. Three calls
    // total: initial eval, generator resume, re-eval.
    let spawnCall = 0;
    const spawnScript = [EVALUATOR_FAILED_OUTPUT, '<task-complete>', EVALUATOR_PASSED_OUTPUT];

    const writeEvaluationCalls: { iteration: number; status: string; body: string }[] = [];
    let savedTaskStatus: string | undefined;

    const persistence = {
      getSprint: () => Promise.resolve(sprint),
      getTask: () => Promise.resolve(task),
      getConfig: () => Promise.resolve(makeConfig({ evaluationIterations: 1 })),
      getTasks: () => Promise.resolve([task]),
      saveTasks: (tasks: Task[]) => {
        savedTaskStatus = tasks[0]?.evaluationStatus;
        return Promise.resolve();
      },
      writeEvaluation: (_sprintId: string, _taskId: string, iteration: number, status: string, body: string) => {
        writeEvaluationCalls.push({ iteration, status, body });
        return Promise.resolve();
      },
      resolveRepoPath: () => Promise.resolve('/tmp/repo'),
      getRepoById: () => Promise.reject(new Error('not configured — findProjectForRepoId falls through to null')),
    } as unknown as PersistencePort;

    const aiSession = {
      ensureReady: () => Promise.resolve(),
      getProviderName: () => 'claude' as const,
      getSpawnEnv: () => ({}),
      spawnWithRetry: (prompt: string): Promise<SessionResult> => {
        spawnPrompts.push(prompt);
        const output = spawnScript[spawnCall] ?? '';
        spawnCall++;
        return Promise.resolve({ output, sessionId: `spawn-${String(spawnCall)}` });
      },
    } as unknown as AiSessionPort;

    const promptBuilder = {
      buildTaskEvaluationPrompt: () => 'evaluator prompt',
    } as unknown as PromptBuilderPort;

    const parser = {
      parseEvaluation: (output: string) => toParseResult(output),
      parseExecutionSignals: (output: string) => ({
        complete: output.includes('<task-complete>'),
        blocked: null,
        verified: null,
      }),
    } as unknown as OutputParserPort;

    const useCase = new EvaluateTaskUseCase(
      persistence,
      aiSession,
      promptBuilder,
      parser,
      makeUi(),
      makeLogger(),
      makeFs(),
      makeExternal()
    );

    const result = await useCase.execute(sprint.id, task.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('passed');
    // Initial eval + resume + re-eval = three spawns.
    expect(spawnCall).toBe(3);

    // The generator-resume spawn is identified by the header string the use
    // case injects in `resumeGeneratorWithCritique`. That prompt MUST carry
    // the critique verbatim, proving the failed feedback is not dropped on
    // the way back into the generator.
    const resumePrompt = spawnPrompts.find((p) => p.includes('## Evaluator Critique'));
    expect(resumePrompt, 'expected a generator-resume spawn carrying the critique').toBeDefined();
    expect(resumePrompt).toContain(SEEDED_FLAW);

    // Sidecar records both iterations. Iteration 2 is the feedback-applied
    // re-evaluation — its body is the passed-output (the fix landed) and the
    // presence of a second sidecar write is the load-bearing signal.
    expect(writeEvaluationCalls).toHaveLength(2);
    expect(writeEvaluationCalls[0]).toMatchObject({ iteration: 1, status: 'failed' });
    expect(writeEvaluationCalls[1]).toMatchObject({ iteration: 2, status: 'passed' });

    // Task record reflects the final pass after the fix iteration.
    expect(savedTaskStatus).toBe('passed');
  });

  it('clean artifact: per-dimension-justified PASS does not trigger a fix iteration', async () => {
    const sprint = makeSprint();
    const task = makeTask();

    const spawnPrompts: string[] = [];
    let spawnCall = 0;
    const writeEvaluationCalls: { iteration: number; status: string }[] = [];
    let savedTaskStatus: string | undefined;

    const persistence = {
      getSprint: () => Promise.resolve(sprint),
      getTask: () => Promise.resolve(task),
      getConfig: () => Promise.resolve(makeConfig({ evaluationIterations: 1 })),
      getTasks: () => Promise.resolve([task]),
      saveTasks: (tasks: Task[]) => {
        savedTaskStatus = tasks[0]?.evaluationStatus;
        return Promise.resolve();
      },
      writeEvaluation: (_sprintId: string, _taskId: string, iteration: number, status: string) => {
        writeEvaluationCalls.push({ iteration, status });
        return Promise.resolve();
      },
      resolveRepoPath: () => Promise.resolve('/tmp/repo'),
      getRepoById: () => Promise.reject(new Error('not configured')),
    } as unknown as PersistencePort;

    const aiSession = {
      ensureReady: () => Promise.resolve(),
      getProviderName: () => 'claude' as const,
      getSpawnEnv: () => ({}),
      spawnWithRetry: (prompt: string): Promise<SessionResult> => {
        spawnPrompts.push(prompt);
        spawnCall++;
        return Promise.resolve({ output: EVALUATOR_PASSED_OUTPUT, sessionId: `spawn-${String(spawnCall)}` });
      },
    } as unknown as AiSessionPort;

    const promptBuilder = {
      buildTaskEvaluationPrompt: () => 'evaluator prompt',
    } as unknown as PromptBuilderPort;

    const parser = {
      parseEvaluation: (output: string) => toParseResult(output),
      parseExecutionSignals: (output: string) => ({
        complete: output.includes('<task-complete>'),
        blocked: null,
        verified: null,
      }),
    } as unknown as OutputParserPort;

    const useCase = new EvaluateTaskUseCase(
      persistence,
      aiSession,
      promptBuilder,
      parser,
      makeUi(),
      makeLogger(),
      makeFs(),
      makeExternal()
    );

    const result = await useCase.execute(sprint.id, task.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('passed');
    // Exactly one evaluator spawn — the fix loop is skipped when the initial
    // evaluation passes, so `resumeGeneratorWithCritique` is not called.
    expect(spawnCall).toBe(1);
    // No prompt ever carried the generator-resume header.
    const resumePrompt = spawnPrompts.find((p) => p.includes('## Evaluator Critique'));
    expect(resumePrompt).toBeUndefined();

    // Sidecar records exactly one iteration (the initial clean pass).
    expect(writeEvaluationCalls).toEqual([{ iteration: 1, status: 'passed' }]);
    // Per the Task schema at `src/domain/models.ts:83-102`, the persisted
    // `evaluationStatus` is `'passed'` when the evaluator returns a clean
    // `<evaluation-passed>` and the fix loop is never entered.
    expect(savedTaskStatus).toBe('passed');
  });
});
