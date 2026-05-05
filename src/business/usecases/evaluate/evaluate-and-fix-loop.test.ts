// Behavior-parity tests for the multi-round evaluator/generator fix loop.
// Mirrors the legacy `evaluate.iterations.test.ts` semantics from the prior
// architecture (afe771f9~1) — iteration cap, plateau short-circuit, malformed
// short-circuit, generator resume threading, and live-config re-read.
import { describe, expect, it } from 'vitest';

import { Sprint } from '@src/domain/entities/sprint.ts';
import { Task } from '@src/domain/entities/task.ts';
import { CONFIG_DEFAULTS } from '@src/application/config/config-defaults.ts';
import type { Config } from '@src/application/config/config.ts';
import type { EvaluationSignal } from '@src/domain/signals/harness-signal.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { Slug } from '@src/domain/values/slug.ts';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import { FakeAiSessionPort, type ScriptedSpawnOutcome } from '@src/business/_test-fakes/fake-ai-session-port.ts';
import { FakeExternalPort } from '@src/business/_test-fakes/fake-external-port.ts';
import { FakeLoggerPort } from '@src/business/_test-fakes/fake-logger-port.ts';
import { FakePromptBuilderPort } from '@src/business/_test-fakes/fake-prompt-builder-port.ts';
import { FakeSignalParserPort } from '@src/business/_test-fakes/fake-signal-parser-port.ts';
import { FakeWriteContextFilePort } from '@src/business/_test-fakes/fake-write-context-file-port.ts';
import { ExecuteSingleTaskUseCase } from '@src/business/usecases/execute/execute-single-task.ts';
import { PostTaskCheckUseCase } from '@src/business/usecases/execute/post-task-check.ts';
import { EvaluateTaskUseCase } from './evaluate-task.ts';
import { EvaluateAndFixLoopUseCase, type EvaluationConfigReader } from './evaluate-and-fix-loop.ts';

const T0 = '2026-04-29T14:15:22.000Z' as IsoTimestamp;

function path(p: string): AbsolutePath {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function slug(s: string): Slug {
  const r = Slug.parse(s);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function projectName(): ProjectName {
  const r = ProjectName.parse('demo');
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function aSprint(): Sprint {
  const s = Sprint.create({ name: 'A', slug: slug('a'), now: T0, projectName: projectName() });
  if (!s.ok) throw new Error('precondition failed');
  return s.value;
}

function aTask(): Task {
  const t = Task.create({
    name: 'do thing',
    steps: [],
    verificationCriteria: [],
    order: 1,
    projectPath: path('/repos/demo'),
  });
  if (!t.ok) throw new Error('precondition failed');
  return t.value;
}

function passSignal(): EvaluationSignal {
  return {
    type: 'evaluation',
    status: 'passed',
    dimensions: [{ dimension: 'correctness', score: 5 as const, passed: true, finding: 'ok' }],
    overallScore: 5,
    timestamp: T0,
  };
}

function failSignal(failedDims: readonly string[] = ['safety']): EvaluationSignal {
  return {
    type: 'evaluation',
    status: 'failed',
    dimensions: failedDims.map((d) => ({ dimension: d, score: 2 as const, passed: false, finding: 'x' })),
    overallScore: 2,
    critique: 'fix it',
    timestamp: T0,
  };
}

function taskCompleteSignal() {
  return { type: 'task-complete' as const, timestamp: T0 };
}

class StaticConfigReader implements EvaluationConfigReader {
  constructor(public readonly config: Config) {}
  current(): Promise<Config> {
    return Promise.resolve(this.config);
  }
}

class MutableConfigReader implements EvaluationConfigReader {
  calls = 0;
  current(): Promise<Config> {
    this.calls += 1;
    const next = this.script.shift();
    return Promise.resolve(next ?? this.fallback);
  }
  constructor(
    public readonly script: Config[],
    public readonly fallback: Config = CONFIG_DEFAULTS
  ) {}
}

function buildLoop(opts: {
  iterations?: number;
  reader?: EvaluationConfigReader;
  evalSignals?: readonly (readonly EvaluationSignal[])[];
  generatorSignals?: readonly (readonly { readonly type: 'task-complete'; readonly timestamp: IsoTimestamp }[])[];
  generatorOutcomes?: readonly ScriptedSpawnOutcome[];
}): {
  loop: EvaluateAndFixLoopUseCase;
  ai: FakeAiSessionPort;
  parser: FakeSignalParserPort;
  prompts: FakePromptBuilderPort;
  writeContextFile: FakeWriteContextFilePort;
  external: FakeExternalPort;
  logger: FakeLoggerPort;
} {
  // The fake AI session is shared between evaluator and generator —
  // each round queues outcomes in this script, so the per-round shape
  // mirrors how a real provider returns alternating eval / fix output.
  const reader =
    opts.reader ?? new StaticConfigReader({ ...CONFIG_DEFAULTS, evaluationIterations: opts.iterations ?? 1 });

  // Build a canonical script: each pair of (eval-output, fix-output)
  // maps to two AI spawns. Tests can override generator outcomes via
  // `generatorOutcomes` to inject session ids.
  const evalCount = opts.evalSignals?.length ?? 0;
  const generatorCount = opts.generatorOutcomes?.length ?? Math.max(0, evalCount - 1);
  const aiOutcomes: ScriptedSpawnOutcome[] = [];
  for (let i = 0; i < evalCount; i += 1) {
    aiOutcomes.push({ kind: 'ok', result: { output: `eval-${String(i)}` } });
    if (i < generatorCount) {
      const fixOutcome = opts.generatorOutcomes?.[i];
      aiOutcomes.push(fixOutcome ?? { kind: 'ok', result: { output: `fix-${String(i)}` } });
    }
  }

  const ai = new FakeAiSessionPort({ outcomes: aiOutcomes });
  // Parser script alternates: evaluator round (n EvaluationSignals), then
  // generator round (task-complete). FakeSignalParserPort returns the
  // next list per `parse()` call.
  const parserResults: (readonly unknown[])[] = [];
  for (let i = 0; i < evalCount; i += 1) {
    parserResults.push(opts.evalSignals?.[i] ?? []);
    if (i < generatorCount) {
      const sig = opts.generatorSignals?.[i] ?? [taskCompleteSignal()];
      parserResults.push(sig);
    }
  }
  const parser = new FakeSignalParserPort({
    results: parserResults as readonly (readonly EvaluationSignal[])[],
  });

  const prompts = new FakePromptBuilderPort();
  const writeContextFile = new FakeWriteContextFilePort();
  const external = new FakeExternalPort();
  const logger = new FakeLoggerPort();

  const evaluator = new EvaluateTaskUseCase(ai, parser, logger);
  const generator = new ExecuteSingleTaskUseCase(ai, parser, logger);
  const checkRunner = new PostTaskCheckUseCase(external, logger);

  const loop = new EvaluateAndFixLoopUseCase(
    reader,
    evaluator,
    generator,
    checkRunner,
    prompts,
    writeContextFile,
    logger
  );

  return { loop, ai, parser, prompts, writeContextFile, external, logger };
}

describe('EvaluateAndFixLoopUseCase', () => {
  it('skips evaluation entirely when evaluationIterations is 0', async () => {
    const { loop, ai, prompts } = buildLoop({ iterations: 0 });

    const result = await loop.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      executePromptFilePath: '/tmp/sprints/a/contexts/execute-task.md',
      contextsDir: path('/tmp/sprints/a/contexts'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rounds).toBe(0);
    expect(result.value.finalSignal).toBeNull();
    expect(result.value.finalCritique).toBe('');
    expect(result.value.plateauDetected).toBe(false);
    expect(result.value.history).toHaveLength(0);
    // No AI spawns at all when disabled.
    expect(ai.captured).toHaveLength(0);
    expect(prompts.evaluateCalls).toHaveLength(0);
  });

  it('runs one round and exits passed (default iterations: 1)', async () => {
    const { loop, ai } = buildLoop({
      iterations: 1,
      evalSignals: [[passSignal()]],
    });

    const result = await loop.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      executePromptFilePath: '/tmp/sprints/a/contexts/execute-task.md',
      contextsDir: path('/tmp/sprints/a/contexts'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rounds).toBe(1);
    expect(result.value.finalSignal?.status).toBe('passed');
    expect(result.value.history).toHaveLength(1);
    // Only the evaluator spawned — no fix attempt on a passing round.
    expect(ai.captured).toHaveLength(1);
  });

  it('runs one round and exits failed when iterations: 1 and evaluator fails (no fix attempt)', async () => {
    const { loop, ai } = buildLoop({
      iterations: 1,
      evalSignals: [[failSignal()]],
    });

    const result = await loop.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      executePromptFilePath: '/tmp/sprints/a/contexts/execute-task.md',
      contextsDir: path('/tmp/sprints/a/contexts'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rounds).toBe(1);
    expect(result.value.finalSignal?.status).toBe('failed');
    expect(result.value.plateauDetected).toBe(false);
    // Cap reached after one evaluator spawn — no generator fix.
    expect(ai.captured).toHaveLength(1);
  });

  it('iterations: 3 — evaluator fails round 1, fix lands, round 2 passes', async () => {
    const { loop, ai, prompts } = buildLoop({
      iterations: 3,
      evalSignals: [[failSignal()], [passSignal()]],
    });

    const result = await loop.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      executePromptFilePath: '/tmp/sprints/a/contexts/execute-task.md',
      contextsDir: path('/tmp/sprints/a/contexts'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rounds).toBe(2);
    expect(result.value.finalSignal?.status).toBe('passed');
    expect(result.value.history.map((h) => h.outcome)).toStrictEqual(['failed', 'passed']);
    // Spawns: evaluator + generator + evaluator = 3.
    expect(ai.captured).toHaveLength(3);
    // Round 2 evaluator was given the round-1 critique.
    expect(prompts.evaluateCalls).toHaveLength(2);
    expect(prompts.evaluateCalls[0]?.previousCritique).toBeUndefined();
    expect(prompts.evaluateCalls[1]?.previousCritique).toBe('eval-0');
  });

  it('iterations: 3 — plateau short-circuits the loop after round 2 with the same failed dimensions', async () => {
    const { loop, ai } = buildLoop({
      iterations: 3,
      evalSignals: [[failSignal(['safety'])], [failSignal(['safety'])]],
    });

    const result = await loop.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      executePromptFilePath: '/tmp/sprints/a/contexts/execute-task.md',
      contextsDir: path('/tmp/sprints/a/contexts'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rounds).toBe(2);
    expect(result.value.plateauDetected).toBe(true);
    expect(result.value.finalSignal?.status).toBe('failed');
    // Spawns: eval + gen + eval = 3. No third fix attempt because plateau halted us.
    expect(ai.captured).toHaveLength(3);
  });

  it('does NOT plateau when failed dimensions differ across rounds', async () => {
    const { loop } = buildLoop({
      iterations: 3,
      evalSignals: [[failSignal(['safety'])], [failSignal(['correctness'])], [passSignal()]],
    });

    const result = await loop.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      executePromptFilePath: '/tmp/sprints/a/contexts/execute-task.md',
      contextsDir: path('/tmp/sprints/a/contexts'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rounds).toBe(3);
    expect(result.value.plateauDetected).toBe(false);
    expect(result.value.finalSignal?.status).toBe('passed');
  });

  it('iterations: 3 — malformed evaluator output exits the loop immediately at that round', async () => {
    // Empty parser results → EvaluateTaskUseCase synthesises a malformed signal.
    const { loop, ai } = buildLoop({
      iterations: 3,
      evalSignals: [[]], // single round, no signal — malformed
    });

    const result = await loop.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      executePromptFilePath: '/tmp/sprints/a/contexts/execute-task.md',
      contextsDir: path('/tmp/sprints/a/contexts'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rounds).toBe(1);
    expect(result.value.finalSignal?.status).toBe('malformed');
    // One evaluator spawn, no fix attempt.
    expect(ai.captured).toHaveLength(1);
  });

  it('threads generator newSessionId through fix rounds (resume continuity)', async () => {
    const { loop, ai } = buildLoop({
      iterations: 3,
      evalSignals: [[failSignal()], [failSignal(['correctness'])], [passSignal()]],
      // Generator returns a sessionId on each fix; the loop should
      // resume from the *latest* session id.
      generatorOutcomes: [
        { kind: 'ok', result: { output: 'fix-0', sessionId: 'gen-001' } },
        { kind: 'ok', result: { output: 'fix-1', sessionId: 'gen-002' } },
      ],
    });

    const result = await loop.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      executePromptFilePath: '/tmp/sprints/a/contexts/execute-task.md',
      contextsDir: path('/tmp/sprints/a/contexts'),
      resumeSessionId: 'initial-gen',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Spawn order: eval, gen(fix-0), eval, gen(fix-1), eval = 5.
    expect(ai.captured).toHaveLength(5);
    // Generator spawn #1 resumes from the initial session id...
    expect(ai.captured[1]?.options.resumeSessionId).toBe('initial-gen');
    // ...and generator spawn #2 resumes from the id reported by spawn #1.
    expect(ai.captured[3]?.options.resumeSessionId).toBe('gen-001');
  });

  it('final critique is the LAST round critique', async () => {
    const { loop } = buildLoop({
      iterations: 3,
      evalSignals: [[failSignal()], [failSignal(['correctness'])], [passSignal()]],
    });

    const result = await loop.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      executePromptFilePath: '/tmp/sprints/a/contexts/execute-task.md',
      contextsDir: path('/tmp/sprints/a/contexts'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.finalCritique).toBe('eval-2');
  });

  it('round count equals the number of evaluator calls', async () => {
    const { loop, prompts } = buildLoop({
      iterations: 3,
      evalSignals: [[failSignal()], [passSignal()]],
    });

    const result = await loop.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      executePromptFilePath: '/tmp/sprints/a/contexts/execute-task.md',
      contextsDir: path('/tmp/sprints/a/contexts'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rounds).toBe(2);
    expect(prompts.evaluateCalls).toHaveLength(2);
  });

  it('runs the post-task check between rounds when a checkScript is provided', async () => {
    const { loop, external } = buildLoop({
      iterations: 3,
      evalSignals: [[failSignal()], [passSignal()]],
    });

    const result = await loop.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      executePromptFilePath: '/tmp/sprints/a/contexts/execute-task.md',
      contextsDir: path('/tmp/sprints/a/contexts'),
      checkScript: 'pnpm test',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // One inter-round check between round 1 (failed) and round 2 (passed).
    expect(external.checkScriptCalls).toHaveLength(1);
    expect(external.checkScriptCalls[0]?.script).toBe('pnpm test');
    expect(external.checkScriptCalls[0]?.phase).toBe('post-task');
  });

  it('skips the inter-round check when no checkScript is provided', async () => {
    const { loop, external } = buildLoop({
      iterations: 3,
      evalSignals: [[failSignal()], [passSignal()]],
    });

    const result = await loop.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      executePromptFilePath: '/tmp/sprints/a/contexts/execute-task.md',
      contextsDir: path('/tmp/sprints/a/contexts'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(external.checkScriptCalls).toHaveLength(0);
  });

  it("logs the task id in 'evaluator round complete' so parallel rounds are distinguishable", async () => {
    const { loop, logger } = buildLoop({
      iterations: 1,
      evalSignals: [[passSignal()]],
    });

    const task = aTask();
    await loop.execute({
      task,
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      executePromptFilePath: '/tmp/sprints/a/contexts/execute-task.md',
      contextsDir: path('/tmp/sprints/a/contexts'),
    });

    const roundComplete = logger.entries.find((e) => e.message.startsWith('evaluator round complete'));
    expect(roundComplete).toBeDefined();
    expect(roundComplete?.message).toContain(String(task.id));
  });

  it('respects mid-loop config changes (live config re-read)', async () => {
    // Round 1 starts with iterations=3. Between rounds the config is
    // edited DOWN to 1, so the loop should exit after round 1 even
    // though the evaluator failed.
    const reader = new MutableConfigReader([
      { ...CONFIG_DEFAULTS, evaluationIterations: 3 }, // initial gate
      { ...CONFIG_DEFAULTS, evaluationIterations: 3 }, // top of round 1
      { ...CONFIG_DEFAULTS, evaluationIterations: 1 }, // post-fail check (cap exhausted)
    ]);
    const { loop, ai } = buildLoop({
      reader,
      evalSignals: [[failSignal()]],
    });

    const result = await loop.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      executePromptFilePath: '/tmp/sprints/a/contexts/execute-task.md',
      contextsDir: path('/tmp/sprints/a/contexts'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rounds).toBe(1);
    expect(result.value.finalSignal?.status).toBe('failed');
    // Cap dropped to 1 mid-loop — no generator fix attempt.
    expect(ai.captured).toHaveLength(1);
  });

  it('forwards addDirs to the evaluator on every round', async () => {
    const { loop, ai } = buildLoop({
      iterations: 3,
      evalSignals: [[failSignal()], [passSignal()]],
    });

    const result = await loop.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      executePromptFilePath: '/tmp/sprints/a/contexts/execute-task.md',
      contextsDir: path('/tmp/sprints/a/contexts'),
      addDirs: [path('/tmp/sprints/a/workspaces/evaluate')],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Spawn 0 = evaluator round 1, spawn 1 = generator fix, spawn 2 = evaluator round 2.
    // Both evaluator spawns must carry the --add-dir args.
    expect(ai.captured[0]?.options.args).toStrictEqual(['--add-dir', '/tmp/sprints/a/workspaces/evaluate']);
    expect(ai.captured[2]?.options.args).toStrictEqual(['--add-dir', '/tmp/sprints/a/workspaces/evaluate']);
    // The generator (fix) spawn does NOT carry the evaluator's add-dir
    // — it runs in the real repo, not the workspace.
    expect(ai.captured[1]?.options.args).toBeUndefined();
  });

  it('uses evaluateSessionCwd as the evaluator cwd when set; generator continues to use input.cwd', async () => {
    // Copilot path: the evaluator spawns inside the workspace mirror,
    // not the real repo. The generator (fix) still spawns in the real
    // repo (input.cwd) because it's editing actual files.
    const { loop, ai } = buildLoop({
      iterations: 3,
      evalSignals: [[failSignal()], [passSignal()]],
    });

    await loop.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      executePromptFilePath: '/tmp/sprints/a/contexts/execute-task.md',
      contextsDir: path('/tmp/sprints/a/contexts'),
      evaluateSessionCwd: path('/tmp/sprints/a/workspaces/evaluate'),
    });

    expect(String(ai.captured[0]?.options.cwd)).toBe('/tmp/sprints/a/workspaces/evaluate');
    expect(String(ai.captured[1]?.options.cwd)).toBe('/repos/demo');
    expect(String(ai.captured[2]?.options.cwd)).toBe('/tmp/sprints/a/workspaces/evaluate');
  });

  it('falls back to input.cwd when evaluateSessionCwd is undefined (Claude path / standalone evaluate)', async () => {
    const { loop, ai } = buildLoop({
      iterations: 1,
      evalSignals: [[passSignal()]],
    });

    await loop.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      executePromptFilePath: '/tmp/sprints/a/contexts/execute-task.md',
      contextsDir: path('/tmp/sprints/a/contexts'),
    });

    expect(String(ai.captured[0]?.options.cwd)).toBe('/repos/demo');
  });

  it('forwards evaluateWorkspaceDir to the prompt builder so the contract-files section renders', async () => {
    const { loop, prompts } = buildLoop({
      iterations: 1,
      evalSignals: [[passSignal()]],
    });

    await loop.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      executePromptFilePath: '/tmp/sprints/a/contexts/execute-task.md',
      contextsDir: path('/tmp/sprints/a/contexts'),
      evaluateWorkspaceDir: '/tmp/sprints/a/workspaces/evaluate',
    });

    expect(prompts.evaluateCalls).toHaveLength(1);
    // FakePromptBuilderPort captures the input bag verbatim — the
    // workspace dir survives the trip through the loop.
    expect(prompts.evaluateCalls[0]?.evaluateWorkspaceDir).toBe('/tmp/sprints/a/workspaces/evaluate');
  });

  it('calls refreshWorkspace at the top of every round (including round 1)', async () => {
    let calls = 0;
    const refreshWorkspace = (): Promise<Result<void, StorageError>> => {
      calls += 1;
      return Promise.resolve(Result.ok(undefined));
    };

    const { loop } = buildLoop({
      iterations: 3,
      evalSignals: [[failSignal()], [passSignal()]],
    });

    await loop.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      executePromptFilePath: '/tmp/sprints/a/contexts/execute-task.md',
      contextsDir: path('/tmp/sprints/a/contexts'),
      refreshWorkspace,
    });

    // Two evaluator rounds → two refresh calls (round 1 included).
    expect(calls).toBe(2);
  });

  it('refreshWorkspace error does NOT block the round: log+continue with stale snapshot', async () => {
    // Best-effort refresh — a disk-full / EPERM during refresh just
    // means the AI sees a slightly-stale snapshot, which beats aborting
    // the round outright.
    const refreshWorkspace = (): Promise<Result<void, StorageError>> =>
      Promise.resolve(Result.error(new StorageError({ subCode: 'io', message: 'EPERM during refresh' })));

    const { loop, ai, logger } = buildLoop({
      iterations: 1,
      evalSignals: [[passSignal()]],
    });

    const result = await loop.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      executePromptFilePath: '/tmp/sprints/a/contexts/execute-task.md',
      contextsDir: path('/tmp/sprints/a/contexts'),
      refreshWorkspace,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The evaluator still ran — round count is 1.
    expect(result.value.rounds).toBe(1);
    expect(ai.captured).toHaveLength(1);
    // The refresh failure surfaces as a warning so the user can see it,
    // but the loop did not abort.
    expect(logger.hasMessage('warn', 'refresh evaluate workspace')).toBe(true);
  });

  it('writes the per-round verdict to rounds/<N>/evaluator/evaluation.md and updates latest-evaluation.md', async () => {
    const { loop, writeContextFile } = buildLoop({
      iterations: 3,
      evalSignals: [[failSignal()], [passSignal()]],
    });

    await loop.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      executePromptFilePath: '/tmp/sprints/a/contexts/execute-task.md',
      contextsDir: path('/tmp/sprints/a/contexts'),
      evaluateWorkspaceDir: '/tmp/sprints/a/workspaces/evaluate',
    });

    const writePaths = writeContextFile.writes.map((w) => String(w.path));
    // Per-round prompt + verdict for both rounds.
    expect(writePaths).toContain('/tmp/sprints/a/workspaces/evaluate/rounds/1/evaluator/prompt.md');
    expect(writePaths).toContain('/tmp/sprints/a/workspaces/evaluate/rounds/1/evaluator/evaluation.md');
    expect(writePaths).toContain('/tmp/sprints/a/workspaces/evaluate/rounds/2/evaluator/prompt.md');
    expect(writePaths).toContain('/tmp/sprints/a/workspaces/evaluate/rounds/2/evaluator/evaluation.md');
    // latest-evaluation.md is updated after every round.
    const latestWrites = writeContextFile.writes.filter(
      (w) => String(w.path) === '/tmp/sprints/a/workspaces/evaluate/latest-evaluation.md'
    );
    expect(latestWrites).toHaveLength(2);
    // The most recent latest write is round 2's body.
    expect(latestWrites[1]?.content).toBe('eval-1');
  });

  it('hands the round-2 generator a critique-aware wrapper pointing at rounds/1/evaluator/evaluation.md', async () => {
    // The fix-round resume must reference the prior round's verdict on
    // disk so the generator reads the critique BEFORE re-reading the
    // spec. Without this the resumed session never sees the evaluator's
    // findings.
    const { loop, ai } = buildLoop({
      iterations: 3,
      evalSignals: [[failSignal()], [passSignal()]],
    });

    await loop.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      executePromptFilePath: '/tmp/sprints/a/contexts/execute-task.md',
      contextsDir: path('/tmp/sprints/a/contexts'),
      evaluateWorkspaceDir: '/tmp/sprints/a/workspaces/evaluate',
    });

    // Spawn 1 = generator fix; the wrapper text is captured as the
    // `prompt` passed into the spawn. The fix wrapper embeds both the
    // critique path and the spec path.
    const fixPrompt = ai.captured[1]?.prompt ?? '';
    expect(fixPrompt).toContain('/tmp/sprints/a/workspaces/evaluate/rounds/1/evaluator/evaluation.md');
    expect(fixPrompt).toContain('/tmp/sprints/a/contexts/execute-task.md');
    // It identifies itself as a fix round so the generator picks the
    // critique-first reading order.
    expect(fixPrompt.toLowerCase()).toContain('fix round');
  });

  it('does NOT pass fixContext when no evaluate workspace is mounted (defensive)', async () => {
    // Standalone evaluate / no workspace → the loop has nowhere to
    // point the generator at, so fall back to the plain wrapper. The
    // fix branch only fires on iterations >= 2, so we exercise the
    // multi-round path without `evaluateWorkspaceDir`.
    const { loop, ai } = buildLoop({
      iterations: 3,
      evalSignals: [[failSignal()], [passSignal()]],
    });

    await loop.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      executePromptFilePath: '/tmp/sprints/a/contexts/execute-task.md',
      contextsDir: path('/tmp/sprints/a/contexts'),
      // intentionally no evaluateWorkspaceDir
    });

    const fixPrompt = ai.captured[1]?.prompt ?? '';
    // The plain wrapper does NOT reference a critique file path.
    expect(fixPrompt.toLowerCase()).not.toContain('fix round');
    expect(fixPrompt).not.toContain('evaluation.md');
  });

  it('threads `round` into nextSessionMdPath so generator/evaluator audits land per-round', async () => {
    const calls: { kind: string; round: number }[] = [];
    const nextSessionMdPath = (kind: 'generator' | 'evaluator', round: number): Promise<undefined> => {
      calls.push({ kind, round });
      return Promise.resolve(undefined);
    };

    const { loop } = buildLoop({
      iterations: 3,
      evalSignals: [[failSignal()], [passSignal()]],
    });

    await loop.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      executePromptFilePath: '/tmp/sprints/a/contexts/execute-task.md',
      contextsDir: path('/tmp/sprints/a/contexts'),
      nextSessionMdPath,
    });

    // Round 1 evaluator → generator fix (round 2 in the upcoming sense)
    // → round 2 evaluator.
    expect(calls).toStrictEqual([
      { kind: 'evaluator', round: 1 },
      { kind: 'generator', round: 2 },
      { kind: 'evaluator', round: 2 },
    ]);
  });

  it('honors a config raise mid-loop (re-read picks up the new ceiling)', async () => {
    // Round 1: cap=1, evaluator fails. After the fail check, cap is
    // raised to 3, so a fix attempt + round 2 should run.
    const reader = new MutableConfigReader([
      { ...CONFIG_DEFAULTS, evaluationIterations: 1 }, // initial gate
      { ...CONFIG_DEFAULTS, evaluationIterations: 1 }, // top of round 1
      { ...CONFIG_DEFAULTS, evaluationIterations: 3 }, // post-fail (raised — fix runs)
      { ...CONFIG_DEFAULTS, evaluationIterations: 3 }, // top of round 2
    ]);
    const { loop, ai } = buildLoop({
      reader,
      evalSignals: [[failSignal()], [passSignal()]],
    });

    const result = await loop.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
      executePromptFilePath: '/tmp/sprints/a/contexts/execute-task.md',
      contextsDir: path('/tmp/sprints/a/contexts'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rounds).toBe(2);
    expect(result.value.finalSignal?.status).toBe('passed');
    // Eval, gen, eval = 3 spawns.
    expect(ai.captured).toHaveLength(3);
  });
});
