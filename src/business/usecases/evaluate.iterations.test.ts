/**
 * Iteration-accuracy regression for the evaluator reporter.
 *
 * Before the fix-loop bugfix, `reportResult` was given `maxIterations` and
 * logged it verbatim, so a run that actually performed 1 evaluator spawn
 * would still print "did not pass after 6 fix attempt(s)". This test pins
 * the new contract: the summary's `iterations` equals the number of spawns
 * the loop really executed.
 */

import { describe, expect, it } from 'vitest';
import type { Config, Sprint, Task } from '@src/domain/models.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { FilesystemPort } from '@src/business/ports/filesystem.ts';
import type { AiSessionPort, SessionOptions, SessionResult } from '@src/business/ports/ai-session.ts';
import type { PromptBuilderPort } from '@src/business/ports/prompt-builder.ts';
import type { EvaluationParseResult, OutputParserPort } from '@src/business/ports/output-parser.ts';
import type { UserInteractionPort } from '@src/business/ports/user-interaction.ts';
import type { LoggerPort, SpinnerHandle } from '@src/business/ports/logger.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import { EvaluateTaskUseCase } from './evaluate.ts';

function makeSprint(): Sprint {
  return {
    id: 'test-sprint',
    name: 'Iteration sprint',
    projectId: 'proj-1',
    status: 'active',
    createdAt: new Date().toISOString(),
    activatedAt: new Date().toISOString(),
    closedAt: null,
    tickets: [],
    checkRanAt: {},
    branch: null,
  };
}

function makeTask(): Task {
  return {
    id: 'task-1',
    name: 'Iteration task',
    steps: [],
    verificationCriteria: [],
    status: 'done',
    order: 1,
    blockedBy: [],
    repoId: 'repo-1',
    verified: true,
    evaluated: false,
  };
}

function makeConfig(iterations: number): Config {
  return {
    currentSprint: null,
    aiProvider: 'claude',
    editor: null,
    evaluationIterations: iterations,
  };
}

function makeSpinner(): SpinnerHandle {
  return {
    succeed: () => undefined,
    fail: () => undefined,
    stop: () => undefined,
  };
}

interface CapturedLogger {
  logger: LoggerPort;
  warnings: string[];
  successes: string[];
  debugs: string[];
}

function makeLogger(): CapturedLogger {
  const warnings: string[] = [];
  const successes: string[] = [];
  const debugs: string[] = [];
  const logger: LoggerPort = {
    debug: (msg) => debugs.push(msg),
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    success: (msg) => successes.push(msg),
    warning: (msg) => warnings.push(msg),
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
  return { logger, warnings, successes, debugs };
}

function makeFs(): FilesystemPort {
  return { getSprintDir: () => '/tmp/sprint' } as unknown as FilesystemPort;
}

function makeExternal(): ExternalPort {
  return { detectProjectTooling: () => '' } as unknown as ExternalPort;
}

function makeUi(): UserInteractionPort {
  return {} as UserInteractionPort;
}

/**
 * Builds a parse-evaluation stub that rotates through a fixture list of
 * parsed-eval results — one per evaluator spawn. The use case spawns the
 * evaluator twice per fix iteration: once for the initial eval and once
 * per re-eval.
 */
function makeRotatingParser(results: EvaluationParseResult[]): OutputParserPort {
  let idx = 0;
  return {
    parseEvaluation: () => {
      const next = results[Math.min(idx, results.length - 1)];
      idx++;
      if (!next) throw new Error(`no parse result for call ${String(idx)}`);
      return next;
    },
    // The fix loop always re-evaluates regardless of `complete` (bug #2 fix).
    // Return `complete: false` to prove the re-eval still runs even when the
    // generator never signals completion.
    parseExecutionSignals: () => ({ complete: false, blocked: null, verified: null }),
  } as unknown as OutputParserPort;
}

describe('EvaluateTaskUseCase — iteration reporting accuracy', () => {
  it('reports the actual iteration count (3), not the configured max (6), when third eval passes', async () => {
    const sprint = makeSprint();
    const task = makeTask();
    const { logger, successes } = makeLogger();

    const parseResults: EvaluationParseResult[] = [
      // Iteration 1 — initial eval, fails on Correctness.
      {
        status: 'failed',
        dimensions: [{ dimension: 'Correctness', status: 'FAIL', description: 'bug A' }],
        rawOutput: 'r1',
      },
      // Iteration 2 — re-eval after 1st fix, different failed dimension so
      // plateau detection does NOT fire.
      {
        status: 'failed',
        dimensions: [{ dimension: 'Safety', status: 'FAIL', description: 'bug B' }],
        rawOutput: 'r2',
      },
      // Iteration 3 — re-eval after 2nd fix, passes.
      { status: 'passed', dimensions: [], rawOutput: 'ok' },
    ];

    const persistence = {
      getSprint: () => Promise.resolve(sprint),
      getTask: () => Promise.resolve(task),
      getConfig: () => Promise.resolve(makeConfig(6)), // user configured 6 max
      getTasks: () => Promise.resolve([task]),
      saveTasks: () => Promise.resolve(),
      writeEvaluation: () => Promise.resolve(),
      resolveRepoPath: () => Promise.resolve('/tmp/repo'),
      getRepoById: () => Promise.reject(new Error('not configured')),
    } as unknown as PersistencePort;

    const aiSession = {
      ensureReady: () => Promise.resolve(),
      getProviderName: () => 'claude' as const,
      getSpawnEnv: () => ({}),
      // Evaluator and generator spawns share this — the test doesn't care
      // which prompt is sent; the parser rotates through the scripted
      // results to drive the fix loop.
      spawnWithRetry: (): Promise<SessionResult> => Promise.resolve({ output: 'any', sessionId: 's' }),
    } as unknown as AiSessionPort;

    const promptBuilder = {
      buildTaskEvaluationPrompt: () => 'evaluator prompt',
      buildTaskEvaluationResumePrompt: () => 'resume prompt',
    } as unknown as PromptBuilderPort;

    const useCase = new EvaluateTaskUseCase(
      persistence,
      aiSession,
      promptBuilder,
      makeRotatingParser(parseResults),
      makeUi(),
      logger,
      makeFs(),
      makeExternal()
    );

    const result = await useCase.execute(sprint.id, task.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 3 spawns happened: iteration 1 (initial) + iteration 2 (re-eval) +
    // iteration 3 (re-eval) — the third one passed, so the loop exits.
    expect(result.value.status).toBe('passed');
    expect(result.value.iterations).toBe(3);

    // Success log fires with the task name — no iteration count required
    // on pass, but the warnings list must not contain the stale "6" number.
    expect(successes.some((s) => s.includes('Evaluation passed'))).toBe(true);
  });

  it('failure log reports the actual iteration count, not the configured max', async () => {
    const sprint = makeSprint();
    const task = makeTask();
    const { logger, warnings } = makeLogger();

    // Configure 6 iterations, but cap this run at iterations=2 so we drive
    // exactly 2 evaluator spawns: initial eval + 1 re-eval (the re-eval
    // after the LAST fix is skipped by design — see the loop-reshape fence
    // test below). The failure log must say "2 iteration(s)", not "6".
    const parseResults: EvaluationParseResult[] = [
      {
        status: 'failed',
        dimensions: [{ dimension: 'Correctness', status: 'FAIL', description: 'A' }],
        rawOutput: 'r1',
      },
      { status: 'failed', dimensions: [{ dimension: 'Safety', status: 'FAIL', description: 'B' }], rawOutput: 'r2' },
    ];

    const persistence = {
      getSprint: () => Promise.resolve(sprint),
      getTask: () => Promise.resolve(task),
      getConfig: () => Promise.resolve(makeConfig(6)),
      getTasks: () => Promise.resolve([task]),
      saveTasks: () => Promise.resolve(),
      writeEvaluation: () => Promise.resolve(),
      resolveRepoPath: () => Promise.resolve('/tmp/repo'),
      getRepoById: () => Promise.reject(new Error('not configured')),
    } as unknown as PersistencePort;

    const aiSession = {
      ensureReady: () => Promise.resolve(),
      getProviderName: () => 'claude' as const,
      getSpawnEnv: () => ({}),
      spawnWithRetry: (): Promise<SessionResult> => Promise.resolve({ output: 'any', sessionId: 's' }),
    } as unknown as AiSessionPort;

    const promptBuilder = {
      buildTaskEvaluationPrompt: () => 'evaluator prompt',
      buildTaskEvaluationResumePrompt: () => 'resume prompt',
    } as unknown as PromptBuilderPort;

    // Iterations=2: initial eval + fix + re-eval + fix (no re-eval after
    // the last fix — that's the loop-reshape optimisation). 2 evaluator
    // spawns total, both fail.
    const useCase = new EvaluateTaskUseCase(
      persistence,
      aiSession,
      promptBuilder,
      makeRotatingParser(parseResults),
      makeUi(),
      logger,
      makeFs(),
      makeExternal()
    );

    const result = await useCase.execute(sprint.id, task.id, { iterations: 2 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('failed');
    expect(result.value.iterations).toBe(2);

    // The failure log must cite the actual count (2), not the configured
    // max (6). The evaluator is advisory: it ends with "— marking done"
    // so the user can see the sprint continued past the failed critique.
    const failureLog = warnings.find((w) => w.includes('Evaluation did not pass'));
    expect(failureLog).toBeDefined();
    expect(failureLog).toContain('2 iteration(s)');
    expect(failureLog).toContain('marking done');
    expect(failureLog).not.toContain('6');
  });

  it('re-evaluates even when the generator does not signal completion (bugfix: no early bail)', async () => {
    const sprint = makeSprint();
    const task = makeTask();
    const { logger, debugs } = makeLogger();

    // Initial eval fails → fix attempt (generator's `parseExecutionSignals`
    // returns `complete: false`, the old code would have bailed here) →
    // re-eval passes. Proves the re-eval runs regardless of the generator's
    // self-report.
    const parseResults: EvaluationParseResult[] = [
      {
        status: 'failed',
        dimensions: [{ dimension: 'Correctness', status: 'FAIL', description: 'A' }],
        rawOutput: 'r1',
      },
      { status: 'passed', dimensions: [], rawOutput: 'ok' },
    ];

    const persistence = {
      getSprint: () => Promise.resolve(sprint),
      getTask: () => Promise.resolve(task),
      getConfig: () => Promise.resolve(makeConfig(2)),
      getTasks: () => Promise.resolve([task]),
      saveTasks: () => Promise.resolve(),
      writeEvaluation: () => Promise.resolve(),
      resolveRepoPath: () => Promise.resolve('/tmp/repo'),
      getRepoById: () => Promise.reject(new Error('not configured')),
    } as unknown as PersistencePort;

    let spawnCount = 0;
    const aiSession = {
      ensureReady: () => Promise.resolve(),
      getProviderName: () => 'claude' as const,
      getSpawnEnv: () => ({}),
      spawnWithRetry: (): Promise<SessionResult> => {
        spawnCount++;
        return Promise.resolve({ output: 'any', sessionId: 's' });
      },
    } as unknown as AiSessionPort;

    const promptBuilder = {
      buildTaskEvaluationPrompt: () => 'evaluator prompt',
      buildTaskEvaluationResumePrompt: () => 'resume prompt',
    } as unknown as PromptBuilderPort;

    // Iterations=2: initial eval + fix + re-eval. The re-eval after the
    // first fix runs because i=0 is NOT the last iteration (maxIterations-1=1).
    // The re-eval passes, so the loop exits before burning the second fix.
    const useCase = new EvaluateTaskUseCase(
      persistence,
      aiSession,
      promptBuilder,
      makeRotatingParser(parseResults),
      makeUi(),
      logger,
      makeFs(),
      makeExternal()
    );

    const result = await useCase.execute(sprint.id, task.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('passed');
    expect(result.value.iterations).toBe(2);
    // 3 spawns: initial eval + 1 generator resume + 1 re-eval. The old
    // early-bail bug would have produced 2 spawns (no re-eval).
    expect(spawnCount).toBe(3);
    // The new diagnostic debug log is emitted when the generator didn't
    // signal completion.
    expect(debugs.some((d) => d.includes('did not signal completion'))).toBe(true);
  });
});

/**
 * Fence tests for the generator-evaluator fix-loop contract.
 *
 * Two load-bearing properties a future refactor must NOT regress:
 *
 *   1. Session continuity — the fix spawn carries `resumeSessionId` equal to
 *      the generator's initial session ID. Without this, each fix attempt
 *      cold-starts with zero memory of what the initial generator built,
 *      defeating the whole point of the generator-evaluator pattern.
 *
 *   2. Template-driven prompt — the fix spawn's prompt is exactly what
 *      `promptBuilder.buildTaskEvaluationResumePrompt(...)` returns.
 *      Before this fix, the use case inlined a 4-line hardcoded string that
 *      silently dropped signals, fix-protocol, harness-context, and commit
 *      instructions — leading to fix attempts that never signalled
 *      completion and silently bailed. The sentinel assertion catches any
 *      regression back to an inline prompt.
 */
describe('EvaluateTaskUseCase — fix-loop fence', () => {
  it('threads generatorSessionId into the fix spawn as resumeSessionId; evaluator spawns carry none', async () => {
    const sprint = makeSprint();
    const task = makeTask();
    const { logger } = makeLogger();

    // Initial eval fails → fix attempt → re-eval passes. Three spawns.
    // Iterations=2 so the fix on i=0 is NOT the last (max-1=1) and the
    // re-eval runs; it passes, so the loop exits before i=1.
    const parseResults: EvaluationParseResult[] = [
      {
        status: 'failed',
        dimensions: [{ dimension: 'Correctness', status: 'FAIL', description: 'A' }],
        rawOutput: 'r1',
      },
      { status: 'passed', dimensions: [], rawOutput: 'ok' },
    ];

    const persistence = {
      getSprint: () => Promise.resolve(sprint),
      getTask: () => Promise.resolve(task),
      getConfig: () => Promise.resolve(makeConfig(2)),
      getTasks: () => Promise.resolve([task]),
      saveTasks: () => Promise.resolve(),
      writeEvaluation: () => Promise.resolve(),
      resolveRepoPath: () => Promise.resolve('/tmp/repo'),
      getRepoById: () => Promise.reject(new Error('not configured')),
    } as unknown as PersistencePort;

    const spawnCalls: { prompt: string; resumeSessionId: string | undefined }[] = [];
    const aiSession = {
      ensureReady: () => Promise.resolve(),
      getProviderName: () => 'claude' as const,
      getSpawnEnv: () => ({}),
      spawnWithRetry: (prompt: string, opts: SessionOptions): Promise<SessionResult> => {
        spawnCalls.push({ prompt, resumeSessionId: opts.resumeSessionId });
        return Promise.resolve({ output: 'any', sessionId: 's' });
      },
    } as unknown as AiSessionPort;

    // Sentinel pattern — the exact string the stub returns is what the use
    // case should pass to spawnWithRetry on the fix attempt. Any future
    // regression to a hardcoded inline prompt string fails the sentinel
    // assertion below.
    const FIX_PROMPT_SENTINEL = 'FIX_PROMPT_SENTINEL_v1';
    const promptBuilder = {
      buildTaskEvaluationPrompt: () => 'evaluator prompt',
      buildTaskEvaluationResumePrompt: () => FIX_PROMPT_SENTINEL,
    } as unknown as PromptBuilderPort;

    const useCase = new EvaluateTaskUseCase(
      persistence,
      aiSession,
      promptBuilder,
      makeRotatingParser(parseResults),
      makeUi(),
      logger,
      makeFs(),
      makeExternal()
    );

    const result = await useCase.execute(sprint.id, task.id, {
      generatorSessionId: 'sess_abc',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('passed');

    // 3 spawns — initial eval (idx 0), fix (idx 1), re-eval (idx 2).
    expect(spawnCalls).toHaveLength(3);

    // Fence 1 — resumeSessionId is set ONLY on the fix spawn.
    expect(spawnCalls[0]?.resumeSessionId).toBeUndefined();
    expect(spawnCalls[1]?.resumeSessionId).toBe('sess_abc');
    expect(spawnCalls[2]?.resumeSessionId).toBeUndefined();

    // Fence 2 — fix spawn's prompt is what the template builder returned,
    // NOT an inline hardcoded string. Regression here means someone
    // re-inlined the prompt.
    expect(spawnCalls[1]?.prompt).toBe(FIX_PROMPT_SENTINEL);
  });

  it('falls back to fresh spawn when generatorSessionId is omitted', async () => {
    // Rare path: the initial generator run didn't yield a session ID (e.g.,
    // the task was re-evaluated outside the per-task pipeline). The use
    // case should degrade cleanly — spawn without `resumeSessionId`, not
    // crash — so the fix still runs, just without continuity.
    const sprint = makeSprint();
    const task = makeTask();
    const { logger } = makeLogger();

    const parseResults: EvaluationParseResult[] = [
      {
        status: 'failed',
        dimensions: [{ dimension: 'Correctness', status: 'FAIL', description: 'A' }],
        rawOutput: 'r1',
      },
      { status: 'passed', dimensions: [], rawOutput: 'ok' },
    ];

    const persistence = {
      getSprint: () => Promise.resolve(sprint),
      getTask: () => Promise.resolve(task),
      getConfig: () => Promise.resolve(makeConfig(2)),
      getTasks: () => Promise.resolve([task]),
      saveTasks: () => Promise.resolve(),
      writeEvaluation: () => Promise.resolve(),
      resolveRepoPath: () => Promise.resolve('/tmp/repo'),
      getRepoById: () => Promise.reject(new Error('not configured')),
    } as unknown as PersistencePort;

    const spawnCalls: { resumeSessionId: string | undefined }[] = [];
    const aiSession = {
      ensureReady: () => Promise.resolve(),
      getProviderName: () => 'claude' as const,
      getSpawnEnv: () => ({}),
      spawnWithRetry: (_prompt: string, opts: SessionOptions): Promise<SessionResult> => {
        spawnCalls.push({ resumeSessionId: opts.resumeSessionId });
        return Promise.resolve({ output: 'any', sessionId: 's' });
      },
    } as unknown as AiSessionPort;

    const promptBuilder = {
      buildTaskEvaluationPrompt: () => 'evaluator prompt',
      buildTaskEvaluationResumePrompt: () => 'resume prompt',
    } as unknown as PromptBuilderPort;

    const useCase = new EvaluateTaskUseCase(
      persistence,
      aiSession,
      promptBuilder,
      makeRotatingParser(parseResults),
      makeUi(),
      logger,
      makeFs(),
      makeExternal()
    );

    // No generatorSessionId supplied. Iterations=2 so the fix on i=0 is
    // NOT the last iteration and the re-eval runs (and passes).
    const result = await useCase.execute(sprint.id, task.id, { iterations: 2 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // All three spawns (initial eval, fix, re-eval) have no resumeSessionId.
    expect(spawnCalls.map((c) => c.resumeSessionId)).toEqual([undefined, undefined, undefined]);
  });
});

/**
 * Fence test for the loop-reshape optimisation.
 *
 * Rule: when the fix attempt on iteration `i` is the LAST one
 * (`i === maxIterations - 1`), the use case skips the re-evaluation. A
 * re-eval on the final fix can't change the outcome (we're out of fix
 * budget — there's no more generator round to drive), so spawning the
 * evaluator one last time only burns a multi-minute Claude run.
 *
 * Concrete claim: with iterations=3 and all evals persistently failing,
 * the evaluator runs exactly 3 times (initial + re-eval after fix 1 +
 * re-eval after fix 2), NOT 4. The last fix (fix 3) ends the loop with
 * no re-eval.
 */
describe('EvaluateTaskUseCase — loop-reshape fence', () => {
  it('skips the re-evaluation on the final fix iteration (iterations=3 → 3 evaluator spawns, not 4)', async () => {
    const sprint = makeSprint();
    const task = makeTask();
    const { logger } = makeLogger();

    // All evaluations fail with rotating dimensions so plateau detection
    // never trips early (which would mask the reshape being under test).
    const parseResults: EvaluationParseResult[] = [
      // Initial eval (spawn 1).
      {
        status: 'failed',
        dimensions: [{ dimension: 'Correctness', status: 'FAIL', description: 'A' }],
        rawOutput: 'e1',
      },
      // Re-eval after fix 1 (spawn 2) — different dimension, no plateau.
      { status: 'failed', dimensions: [{ dimension: 'Safety', status: 'FAIL', description: 'B' }], rawOutput: 'e2' },
      // Re-eval after fix 2 (spawn 3) — different dimension again.
      {
        status: 'failed',
        dimensions: [{ dimension: 'Completeness', status: 'FAIL', description: 'C' }],
        rawOutput: 'e3',
      },
      // If the reshape regresses and the loop re-evaluates after fix 3,
      // this entry would be consumed and the spawn count would be 4.
      {
        status: 'failed',
        dimensions: [{ dimension: 'Correctness', status: 'FAIL', description: 'D' }],
        rawOutput: 'e4',
      },
    ];

    const persistence = {
      getSprint: () => Promise.resolve(sprint),
      getTask: () => Promise.resolve(task),
      getConfig: () => Promise.resolve(makeConfig(3)),
      getTasks: () => Promise.resolve([task]),
      saveTasks: () => Promise.resolve(),
      writeEvaluation: () => Promise.resolve(),
      resolveRepoPath: () => Promise.resolve('/tmp/repo'),
      getRepoById: () => Promise.reject(new Error('not configured')),
    } as unknown as PersistencePort;

    // Count evaluator spawns distinctly from fix (generator) spawns. The
    // use case identifies an evaluator spawn by the prompt string the
    // promptBuilder returns — we tag each builder output so the stub can
    // classify.
    const EVAL_PROMPT = 'evaluator prompt SENTINEL';
    const FIX_PROMPT = 'resume prompt SENTINEL';
    let evaluatorSpawns = 0;
    let fixSpawns = 0;
    const aiSession = {
      ensureReady: () => Promise.resolve(),
      getProviderName: () => 'claude' as const,
      getSpawnEnv: () => ({}),
      spawnWithRetry: (prompt: string): Promise<SessionResult> => {
        if (prompt === EVAL_PROMPT) evaluatorSpawns++;
        else if (prompt === FIX_PROMPT) fixSpawns++;
        return Promise.resolve({ output: 'any', sessionId: 's' });
      },
    } as unknown as AiSessionPort;

    const promptBuilder = {
      buildTaskEvaluationPrompt: () => EVAL_PROMPT,
      buildTaskEvaluationResumePrompt: () => FIX_PROMPT,
    } as unknown as PromptBuilderPort;

    const useCase = new EvaluateTaskUseCase(
      persistence,
      aiSession,
      promptBuilder,
      makeRotatingParser(parseResults),
      makeUi(),
      logger,
      makeFs(),
      makeExternal()
    );

    const result = await useCase.execute(sprint.id, task.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 3 evaluator spawns: initial + 2 re-evals (after fix 1, after fix 2).
    // The re-eval after fix 3 is DELIBERATELY skipped — that's the
    // optimisation this fence locks in.
    expect(evaluatorSpawns).toBe(3);
    // 3 fix spawns: one per iteration of the loop.
    expect(fixSpawns).toBe(3);
    // Reported iteration count matches the evaluator spawn count.
    expect(result.value.iterations).toBe(3);
    expect(result.value.status).toBe('failed');
  });
});
