import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { EvaluationSignal, HarnessSignal } from '@src/domain/signal.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { AiSignalEvent, AppEvent } from '@src/business/observability/events.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { createInMemorySink } from '@tests/fixtures/in-memory-sink.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { renderEvaluationMarkdown } from '@src/integration/ai/contract/_engine/render-evaluation-markdown.ts';
import { absolutePath, FIXED_NOW, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import { createMockHeadlessProvider, type SpawnFixture } from '@tests/helpers/mock-headless-provider.ts';
import type { EvaluatorLeafDeps } from '@src/application/flows/implement/leaves/evaluator.ts';
import { evaluatorLeaf } from '@src/application/flows/implement/leaves/evaluator.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Audit-[10] nine-branch grid against the audit-[09] evaluator contract.
 *
 * Each case constructs a tmpdir, points `signalsFile` at
 * `<root>/rounds/1/evaluator/signals.json`, registers one fixture against that exact path,
 * and asserts on the leaf's `Result`, the bus's `ai-signal` fan-out, and the on-disk
 * sidecar (`evaluation.md` rendered via `renderEvaluationMarkdown`). The fake template loader
 * renders the real evaluate template so the leaf's pre-spawn prompt-write side effect lands
 * in the expected dir.
 */

describe('evaluatorLeaf — audit-[09] contract', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;

  beforeEach(async () => {
    root = await makeTmpRoot();
  });

  afterEach(async () => {
    await root.cleanup();
  });

  const signalsFilePath = (): string => join(String(root.root), 'rounds', '1', 'evaluator', 'signals.json');
  const sidecarPath = (): string => join(String(root.root), 'rounds', '1', 'evaluator', 'evaluation.md');

  /**
   * Build the leaf deps along with two inspectable handles — the in-memory sink (so tests
   * can read what the leaf emitted to the legacy fan-out) and the recorded mock provider
   * invocations. Returning the rich tuple keeps the test bodies free of casts.
   */
  const buildDeps = (
    fixtures: Map<string, SpawnFixture>,
    eventBus = createInMemoryEventBus()
  ): {
    readonly deps: EvaluatorLeafDeps;
    readonly sink: ReturnType<typeof createInMemorySink<HarnessSignal>>;
  } => {
    const mock = createMockHeadlessProvider({ fixtures });
    // `WriteFile` adapter — real disk writes so sidecars land where the production helper
    // would write them and tests can read them back. No port mock needed.
    const writeFile: EvaluatorLeafDeps['writeFile'] = async (path, content) => {
      try {
        await fs.mkdir(join(String(path), '..'), { recursive: true });
        await fs.writeFile(String(path), content, 'utf8');
        return Result.ok(undefined);
      } catch (cause) {
        return Result.error({ message: String(cause) } as never);
      }
    };
    const sink = createInMemorySink<HarnessSignal>();
    const deps: EvaluatorLeafDeps = {
      provider: mock.provider,
      templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
      signals: sink,
      writeFile,
      cwd: absolutePath('/tmp/ralph/fake-cwd'),
      sprintDir: absolutePath('/tmp/ralph/fake-sprint-dir'),
      progressFile: absolutePath('/tmp/ralph/fake-sprint-dir/progress.md'),
      model: 'test-model',
      plateauThreshold: 2,
      clock: () => FIXED_NOW,
      logger: noopLogger,
      eventBus,
    };
    return { deps, sink };
  };

  const baseCtx = (task: ReturnType<typeof makeInProgressTaskWithRunningAttempt>): ImplementCtx => ({
    sprintId: task.id as unknown as ImplementCtx['sprintId'],
    tasks: [task],
    currentTask: task,
    // Evaluator reads `currentRoundNum` from ctx — pinning it to 1 keeps the on-disk paths
    // deterministic for the fixture lookup.
    currentRoundNum: 1,
    taskWorkspaceRoot: root.root,
  });

  const captureBus = (eventBus = createInMemoryEventBus()): { events: AppEvent[]; eventBus: typeof eventBus } => {
    const events: AppEvent[] = [];
    eventBus.subscribe((e) => {
      events.push(e);
    });
    return { events, eventBus };
  };

  const passedEvaluation: EvaluationSignal = {
    type: 'evaluation',
    status: 'passed',
    dimensions: [{ dimension: 'correctness', passed: true, finding: 'all good' }],
    critique: 'Solid pass.',
    timestamp: '2026-05-22T10:00:00.000Z' as EvaluationSignal['timestamp'],
  };

  const failedEvaluation: EvaluationSignal = {
    type: 'evaluation',
    status: 'failed',
    dimensions: [{ dimension: 'correctness', passed: false, finding: 'returns wrong type' }],
    critique: 'Fix the return type before merging.',
    timestamp: '2026-05-22T10:00:00.000Z' as EvaluationSignal['timestamp'],
  };

  // ── 1. Happy path ─────────────────────────────────────────────────────────────
  it('ok: validates signals, writes evaluation.md byte-for-byte, fans out to bus + sink', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const fixtures = new Map<string, SpawnFixture>([
      [
        signalsFilePath(),
        {
          kind: 'ok',
          payload: {
            schemaVersion: 1,
            signals: [
              { type: 'note', text: 'reviewing diff', timestamp: '2026-05-22T10:00:00.000Z' },
              { type: 'task-verified', output: 'tests pass', timestamp: '2026-05-22T10:00:01.000Z' },
              passedEvaluation,
            ],
          },
        },
      ],
    ]);
    const { events, eventBus } = captureBus();
    const { deps, sink } = buildDeps(fixtures, eventBus);
    const leaf = evaluatorLeaf(deps, task.id);

    const result = await leaf.execute(baseCtx(task));
    expect(result.ok).toBe(true);

    // Sidecar exists with the EXACT output of renderEvaluationMarkdown applied to the evaluation
    // signal — proves the leaf's sidecar render path round-trips through the shared formatter
    // without inlining any prose convention at the call site.
    const sidecar = await fs.readFile(sidecarPath(), 'utf8');
    expect(sidecar).toBe(renderEvaluationMarkdown(passedEvaluation));

    // Bus fan-out: every validated signal carried as a typed `ai-signal` event with source
    // 'evaluator'.
    const aiSignals = events.filter((e): e is AiSignalEvent => e.type === 'ai-signal');
    expect(aiSignals.map((e) => e.signal.type)).toEqual(['note', 'task-verified', 'evaluation']);
    for (const ev of aiSignals) expect(ev.source).toBe('evaluator');

    // The legacy sink still sees the same signals (TUI consumers stay happy until Wave 6).
    expect(sink.entries.map((s: HarnessSignal) => s.type)).toEqual(['note', 'task-verified', 'evaluation']);

    // The use case projects the evaluation onto ctx.lastEvaluation.
    if (!result.ok) return;
    expect(result.value.ctx.lastEvaluation?.status).toBe('passed');
  });

  // ── 1b. Happy path — failed verdict still produces the sidecar ────────────────
  it("ok with status='failed': sidecar still written, lastEvaluation reflects the verdict", async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const fixtures = new Map<string, SpawnFixture>([
      [
        signalsFilePath(),
        {
          kind: 'ok',
          payload: { schemaVersion: 1, signals: [failedEvaluation] },
        },
      ],
    ]);
    const leaf = evaluatorLeaf(buildDeps(fixtures).deps, task.id);
    const result = await leaf.execute(baseCtx(task));
    expect(result.ok).toBe(true);

    const sidecar = await fs.readFile(sidecarPath(), 'utf8');
    expect(sidecar).toBe(renderEvaluationMarkdown(failedEvaluation));

    if (!result.ok) return;
    expect(result.value.ctx.lastEvaluation?.status).toBe('failed');
  });

  // A recoverable signals-contract failure (missing / malformed / schema-mismatch / refinement)
  // no longer aborts the run via Result.error — the evaluator turn converts it into a
  // `self-blocked` exit so ONLY this task blocks (settled `blocked`, NOT done-with-warning, so
  // the generator's ungraded change is never committed). The leaf returns `Result.ok` with
  // `ctx.lastExit` set; the precise validator message is preserved in the block reason.
  const expectSelfBlock = (
    result: Awaited<ReturnType<ReturnType<typeof evaluatorLeaf>['execute']>>,
    messageFragment: string
  ): void => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.lastExit?.kind).toBe('self-blocked');
    if (result.value.ctx.lastExit?.kind === 'self-blocked') {
      expect(result.value.ctx.lastExit.reason).toContain('evaluator did not produce a valid signals.json');
      expect(result.value.ctx.lastExit.reason).toContain(messageFragment);
    }
  };

  // ── 2. signals.json missing ───────────────────────────────────────────────────
  it('ok-missing: self-blocks with signals-missing in the reason', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const fixtures = new Map<string, SpawnFixture>([[signalsFilePath(), { kind: 'ok-missing' }]]);
    const leaf = evaluatorLeaf(buildDeps(fixtures).deps, task.id);
    const result = await leaf.execute(baseCtx(task));
    expectSelfBlock(result, 'signals-missing');
  });

  // ── 3. Malformed JSON ─────────────────────────────────────────────────────────
  it('ok-raw with invalid JSON: self-blocks with malformed JSON in the reason', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const fixtures = new Map<string, SpawnFixture>([
      [signalsFilePath(), { kind: 'ok-raw', rawBody: '{ this is not json' }],
    ]);
    const leaf = evaluatorLeaf(buildDeps(fixtures).deps, task.id);
    const result = await leaf.execute(baseCtx(task));
    expectSelfBlock(result, 'malformed JSON');
  });

  // ── 4. Schema fails Zod (wrong shape) ─────────────────────────────────────────
  it('ok with generator-only commit-message signal: self-blocks with schema in the reason', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const fixtures = new Map<string, SpawnFixture>([
      [
        signalsFilePath(),
        {
          kind: 'ok',
          payload: {
            schemaVersion: 1,
            // `commit-message` is intentionally not part of the evaluator contract — the
            // generator emits it. An evaluator-side `commit-message` MUST be rejected by Zod.
            signals: [{ type: 'commit-message', subject: 'feat: x', timestamp: '2026-05-22T10:00:00.000Z' }],
          },
        },
      ],
    ]);
    const leaf = evaluatorLeaf(buildDeps(fixtures).deps, task.id);
    const result = await leaf.execute(baseCtx(task));
    expectSelfBlock(result, 'schema');
  });

  // ── 5a. Schema fails refine — zero evaluations ───────────────────────────────
  it('ok with zero evaluation signals: refinement rejects → self-block', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const fixtures = new Map<string, SpawnFixture>([
      [
        signalsFilePath(),
        {
          kind: 'ok',
          payload: {
            schemaVersion: 1,
            signals: [{ type: 'note', text: 'no verdict here', timestamp: '2026-05-22T10:00:00.000Z' }],
          },
        },
      ],
    ]);
    const leaf = evaluatorLeaf(buildDeps(fixtures).deps, task.id);
    const result = await leaf.execute(baseCtx(task));
    expectSelfBlock(result, 'exactly one evaluation');
  });

  // ── 5b. Schema fails refine — two evaluations ────────────────────────────────
  it('ok with two evaluation signals: refinement rejects → self-block', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const fixtures = new Map<string, SpawnFixture>([
      [
        signalsFilePath(),
        {
          kind: 'ok',
          payload: {
            schemaVersion: 1,
            signals: [passedEvaluation, failedEvaluation],
          },
        },
      ],
    ]);
    const leaf = evaluatorLeaf(buildDeps(fixtures).deps, task.id);
    const result = await leaf.execute(baseCtx(task));
    expectSelfBlock(result, 'exactly one evaluation');
  });

  // ── 7 (migration). Legacy top-level-array shape ───────────────────────────────
  it('migrations[0] wraps legacy top-level array shape into { schemaVersion, signals }', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    // The payload is the bare array today's adapters write (`JSON.stringify(parseHarnessSignals(...))`).
    // The contract's migration step turns this into `{ schemaVersion: 1, signals: [...] }` at
    // validation time.
    const fixtures = new Map<string, SpawnFixture>([
      [
        signalsFilePath(),
        {
          kind: 'ok',
          payload: [{ type: 'change', text: 'legacy shape', timestamp: '2026-05-22T10:00:00.000Z' }, passedEvaluation],
        },
      ],
    ]);
    const { events, eventBus } = captureBus();
    const leaf = evaluatorLeaf(buildDeps(fixtures, eventBus).deps, task.id);

    const result = await leaf.execute(baseCtx(task));
    expect(result.ok).toBe(true);

    const aiSignals = events.filter((e): e is AiSignalEvent => e.type === 'ai-signal');
    expect(aiSignals.map((e) => e.signal.type)).toEqual(['change', 'evaluation']);

    // Sidecar still lands — migration is transparent to downstream render.
    const sidecar = await fs.readFile(sidecarPath(), 'utf8');
    expect(sidecar).toBe(renderEvaluationMarkdown(passedEvaluation));
  });

  // ── 8. Spawn error ────────────────────────────────────────────────────────────
  it('spawn-error: self-blocks the task with the spawn error message, no validation attempted', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const spawnError = new InvalidStateError({
      entity: 'provider',
      currentState: 'broken',
      attemptedAction: 'evaluate',
      message: 'simulated spawn failure',
    });
    const fixtures = new Map<string, SpawnFixture>([[signalsFilePath(), { kind: 'spawn-error', error: spawnError }]]);
    const leaf = evaluatorLeaf(buildDeps(fixtures).deps, task.id);

    const result = await leaf.execute(baseCtx(task));
    // A non-zero spawn (InvalidStateError, recoverable) blocks this task rather than aborting
    // the whole run; the spawn error message is preserved in the block reason.
    expectSelfBlock(result, 'simulated spawn failure');

    // No signals.json file should exist on disk (the mock didn't write one) and no sidecar.
    await expect(fs.access(signalsFilePath())).rejects.toThrow();
    await expect(fs.access(sidecarPath())).rejects.toThrow();
  });

  // ── 9. Abort during spawn ─────────────────────────────────────────────────────
  it('abort: AbortError propagates transparently through the leaf', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const fixtures = new Map<string, SpawnFixture>([[signalsFilePath(), { kind: 'abort' }]]);
    const leaf = evaluatorLeaf(buildDeps(fixtures).deps, task.id);

    // The mock throws AbortError; the leaf primitive treats it as a DomainError (it has a
    // string `code`) and surfaces it via Result.error. The "transparent" contract is that
    // the error instance survives end-to-end without being swallowed or remapped.
    const result = await leaf.execute(baseCtx(task));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(AbortError);
  });
});
