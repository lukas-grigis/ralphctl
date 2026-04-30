// Behavior-parity tests for the multi-round evaluator/generator fix loop.
// Mirrors the legacy `evaluate.iterations.test.ts` semantics from the prior
// architecture (afe771f9~1) — iteration cap, plateau short-circuit, malformed
// short-circuit, generator resume threading, and live-config re-read.
import { describe, expect, it } from 'vitest';

import { Sprint } from '../../../domain/entities/sprint.ts';
import { Task } from '../../../domain/entities/task.ts';
import { CONFIG_DEFAULTS } from '../../../application/config/config-defaults.ts';
import type { Config } from '../../../application/config/config.ts';
import type { EvaluationSignal } from '../../../domain/signals/harness-signal.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import { Slug } from '../../../domain/values/slug.ts';
import { FakeAiSessionPort, type ScriptedSpawnOutcome } from '../../_test-fakes/fake-ai-session-port.ts';
import { FakeExternalPort } from '../../_test-fakes/fake-external-port.ts';
import { FakeLoggerPort } from '../../_test-fakes/fake-logger-port.ts';
import { FakePromptBuilderPort } from '../../_test-fakes/fake-prompt-builder-port.ts';
import { FakeSignalParserPort } from '../../_test-fakes/fake-signal-parser-port.ts';
import { ExecuteSingleTaskUseCase } from '../execute/execute-single-task.ts';
import { PostTaskCheckUseCase } from '../execute/post-task-check.ts';
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

function aSprint(): Sprint {
  const s = Sprint.create({ name: 'A', slug: slug('a'), now: T0 });
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
    dimensions: [{ dimension: 'correctness', passed: true, finding: 'ok' }],
    timestamp: T0,
  };
}

function failSignal(failedDims: readonly string[] = ['safety']): EvaluationSignal {
  return {
    type: 'evaluation',
    status: 'failed',
    dimensions: failedDims.map((d) => ({ dimension: d, passed: false, finding: 'x' })),
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
  const external = new FakeExternalPort();
  const logger = new FakeLoggerPort();

  const evaluator = new EvaluateTaskUseCase(ai, prompts, parser, logger);
  const generator = new ExecuteSingleTaskUseCase(ai, prompts, parser, logger);
  const checkRunner = new PostTaskCheckUseCase(external, logger);

  const loop = new EvaluateAndFixLoopUseCase(reader, evaluator, generator, checkRunner, logger);

  return { loop, ai, parser, prompts, external, logger };
}

describe('EvaluateAndFixLoopUseCase', () => {
  it('skips evaluation entirely when evaluationIterations is 0', async () => {
    const { loop, ai, prompts } = buildLoop({ iterations: 0 });

    const result = await loop.execute({
      task: aTask(),
      sprint: aSprint(),
      cwd: path('/repos/demo'),
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
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rounds).toBe(2);
    expect(result.value.finalSignal?.status).toBe('passed');
    expect(result.value.history.map((h) => h.outcome)).toEqual(['failed', 'passed']);
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
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(external.checkScriptCalls).toHaveLength(0);
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
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rounds).toBe(1);
    expect(result.value.finalSignal?.status).toBe('failed');
    // Cap dropped to 1 mid-loop — no generator fix attempt.
    expect(ai.captured).toHaveLength(1);
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
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rounds).toBe(2);
    expect(result.value.finalSignal?.status).toBe('passed');
    // Eval, gen, eval = 3 spawns.
    expect(ai.captured).toHaveLength(3);
  });
});
