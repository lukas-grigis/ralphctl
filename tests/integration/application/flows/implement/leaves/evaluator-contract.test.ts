import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { EvaluationSignal } from '@src/domain/signal.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { AiSignalEvent, AppEvent } from '@src/business/observability/events.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { createPublishSignal } from '@src/application/flows/_shared/publish-signal.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { renderEvaluationMarkdown } from '@src/integration/ai/contract/_engine/render-evaluation-markdown.ts';
import { absolutePath, FIXED_NOW, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import { createMockHeadlessProvider, type SpawnFixture } from '@tests/helpers/mock-headless-provider.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import type { EvaluatorLeafDeps } from '@src/application/flows/implement/leaves/evaluator.ts';
import { evaluatorLeaf } from '@src/application/flows/implement/leaves/evaluator.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/** Clean-tree git stub — the post-spawn fingerprint call is inert in these contract tests. */
const stubGitRunner = (): GitRunner => ({
  async run() {
    return Result.ok({ stdout: '', stderr: '', exitCode: 0 });
  },
});

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
   * Build the leaf deps — `publishSignal` is bound to this leaf's `eventBus` with
   * `source: 'evaluator'` so tests can assert on the fanned-out `ai-signal` events (via
   * `captureBus`) instead of a legacy sink.
   */
  const buildDeps = (fixtures: Map<string, SpawnFixture>, eventBus = createInMemoryEventBus()): EvaluatorLeafDeps => {
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
    return {
      provider: mock.provider,
      templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
      publishSignal: createPublishSignal(eventBus, 'evaluator'),
      writeFile,
      cwd: absolutePath('/tmp/ralph/fake-cwd'),
      sprintDir: absolutePath('/tmp/ralph/fake-sprint-dir'),
      progressFile: absolutePath('/tmp/ralph/fake-sprint-dir/progress.md'),
      model: 'test-model',
      plateauThreshold: 2,
      correctiveRetries: 1,
      gitRunner: stubGitRunner(),
      clock: () => FIXED_NOW,
      logger: noopLogger,
    };
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

  // Terminal verdicts now MUST grade all five floor dimensions (correctness / completeness /
  // safety / consistency / robustness), so every fixture below carries the full floor set.
  const floorPasses = [
    { dimension: 'completeness', passed: true, finding: 'all steps shipped' },
    { dimension: 'safety', passed: true, finding: 'inputs validated' },
    { dimension: 'consistency', passed: true, finding: 'matches siblings' },
    { dimension: 'robustness', passed: true, finding: 'error paths handled' },
  ];

  const passedEvaluation: EvaluationSignal = {
    type: 'evaluation',
    status: 'passed',
    dimensions: [{ dimension: 'correctness', passed: true, finding: 'all good' }, ...floorPasses],
    critique: 'Solid pass.',
    timestamp: '2026-05-22T10:00:00.000Z' as EvaluationSignal['timestamp'],
  };

  const failedEvaluation: EvaluationSignal = {
    type: 'evaluation',
    status: 'failed',
    dimensions: [{ dimension: 'correctness', passed: false, finding: 'returns wrong type' }, ...floorPasses],
    critique: 'Fix the return type before merging.',
    timestamp: '2026-05-22T10:00:00.000Z' as EvaluationSignal['timestamp'],
  };

  // ── 1. Happy path ─────────────────────────────────────────────────────────────
  it('ok: validates signals, writes evaluation.md byte-for-byte, publishes every signal onto the bus', async () => {
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
    const deps = buildDeps(fixtures, eventBus);
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
    const leaf = evaluatorLeaf(buildDeps(fixtures), task.id);
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
    const leaf = evaluatorLeaf(buildDeps(fixtures), task.id);
    const result = await leaf.execute(baseCtx(task));
    expectSelfBlock(result, 'signals-missing');
  });

  // ── 3. Malformed JSON ─────────────────────────────────────────────────────────
  it('ok-raw with invalid JSON: self-blocks with malformed JSON in the reason', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const fixtures = new Map<string, SpawnFixture>([
      [signalsFilePath(), { kind: 'ok-raw', rawBody: '{ this is not json' }],
    ]);
    const leaf = evaluatorLeaf(buildDeps(fixtures), task.id);
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
    const leaf = evaluatorLeaf(buildDeps(fixtures), task.id);
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
    const leaf = evaluatorLeaf(buildDeps(fixtures), task.id);
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
    const leaf = evaluatorLeaf(buildDeps(fixtures), task.id);
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
    const leaf = evaluatorLeaf(buildDeps(fixtures, eventBus), task.id);

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
    const leaf = evaluatorLeaf(buildDeps(fixtures), task.id);

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
    const leaf = evaluatorLeaf(buildDeps(fixtures), task.id);

    // The mock throws AbortError; the leaf primitive treats it as a DomainError (it has a
    // string `code`) and surfaces it via Result.error. The "transparent" contract is that
    // the error instance survives end-to-end without being swallowed or remapped.
    const result = await leaf.execute(baseCtx(task));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(AbortError);
  });

  // ── Floor-dimension refinement — a vacuous PASS (partial floor set) is rejected ───
  it('vacuous PASS (only correctness graded): floor refinement rejects → self-block', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const fixtures = new Map<string, SpawnFixture>([
      [
        signalsFilePath(),
        {
          kind: 'ok',
          payload: {
            schemaVersion: 1,
            // A "passed" with only the correctness dimension — exactly the vacuous-pass hole the
            // floor refinement closes. Without the corrective retry's second spawn this blocks.
            signals: [
              {
                type: 'evaluation',
                status: 'passed',
                dimensions: [{ dimension: 'correctness', passed: true, finding: 'all good' }],
                timestamp: '2026-05-22T10:00:00.000Z',
              },
            ],
          },
        },
      ],
    ]);
    const leaf = evaluatorLeaf(buildDeps(fixtures), task.id);
    const result = await leaf.execute(baseCtx(task));
    expectSelfBlock(result, 'schema');
  });

  // ── Corrective retry — recovers when the second (resumed) spawn writes a valid file ──
  it('corrective retry: first spawn writes a vacuous PASS, resumed spawn writes the full floor set → ok', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    // Two spawns against the SAME signalsFile path: spawn 1 fails the floor refinement, spawn 2
    // (the resumed corrective turn) writes a complete passing verdict.
    const sequences = new Map<string, readonly SpawnFixture[]>([
      [
        signalsFilePath(),
        [
          {
            kind: 'ok',
            payload: {
              schemaVersion: 1,
              signals: [
                {
                  type: 'evaluation',
                  status: 'passed',
                  dimensions: [{ dimension: 'correctness', passed: true, finding: 'all good' }],
                  timestamp: '2026-05-22T10:00:00.000Z',
                },
              ],
            },
          },
          { kind: 'ok', payload: { schemaVersion: 1, signals: [passedEvaluation] } },
        ],
      ],
    ]);
    const mock = createMockHeadlessProvider({ sequences });
    const writeFile: EvaluatorLeafDeps['writeFile'] = async (path, content) => {
      await fs.mkdir(join(String(path), '..'), { recursive: true });
      await fs.writeFile(String(path), content, 'utf8');
      return Result.ok(undefined);
    };
    const deps: EvaluatorLeafDeps = {
      provider: mock.provider,
      templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
      publishSignal: createPublishSignal(createInMemoryEventBus(), 'evaluator'),
      writeFile,
      cwd: absolutePath('/tmp/ralph/fake-cwd'),
      sprintDir: absolutePath('/tmp/ralph/fake-sprint-dir'),
      progressFile: absolutePath('/tmp/ralph/fake-sprint-dir/progress.md'),
      model: 'test-model',
      plateauThreshold: 2,
      correctiveRetries: 1,
      gitRunner: stubGitRunner(),
      clock: () => FIXED_NOW,
      logger: noopLogger,
    };
    const leaf = evaluatorLeaf(deps, task.id);
    const result = await leaf.execute(baseCtx(task));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The recovered verdict is a clean PASS — the loop's terminal `passed` exit, NOT a self-block.
    expect(result.value.ctx.lastExit?.kind).toBe('passed');
    expect(result.value.ctx.lastEvaluation?.status).toBe('passed');
    // Exactly two spawns: the original + ONE corrective retry (no loop).
    expect(mock.invocations).toHaveLength(2);
    // Forensic body mirror: the initial spawn captures `body.txt`, the corrective nudge captures a
    // distinct `body-corrective-1.txt` so a nudge never clobbers the original spawn's capture.
    expect(String(mock.invocations[0]?.session.bodyFile)).toMatch(/\/rounds\/\d+\/evaluator\/body\.txt$/);
    expect(String(mock.invocations[1]?.session.bodyFile)).toMatch(/\/rounds\/\d+\/evaluator\/body-corrective-1\.txt$/);
  });

  it('corrective retry exhausted: both spawns write a vacuous PASS → self-block (one retry max)', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const vacuous: SpawnFixture = {
      kind: 'ok',
      payload: {
        schemaVersion: 1,
        signals: [
          {
            type: 'evaluation',
            status: 'passed',
            dimensions: [{ dimension: 'correctness', passed: true, finding: 'all good' }],
            timestamp: '2026-05-22T10:00:00.000Z',
          },
        ],
      },
    };
    const sequences = new Map<string, readonly SpawnFixture[]>([[signalsFilePath(), [vacuous, vacuous]]]);
    const mock = createMockHeadlessProvider({ sequences });
    const writeFile: EvaluatorLeafDeps['writeFile'] = async (path, content) => {
      await fs.mkdir(join(String(path), '..'), { recursive: true });
      await fs.writeFile(String(path), content, 'utf8');
      return Result.ok(undefined);
    };
    const deps: EvaluatorLeafDeps = {
      provider: mock.provider,
      templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
      publishSignal: createPublishSignal(createInMemoryEventBus(), 'evaluator'),
      writeFile,
      cwd: absolutePath('/tmp/ralph/fake-cwd'),
      sprintDir: absolutePath('/tmp/ralph/fake-sprint-dir'),
      progressFile: absolutePath('/tmp/ralph/fake-sprint-dir/progress.md'),
      model: 'test-model',
      plateauThreshold: 2,
      correctiveRetries: 1,
      gitRunner: stubGitRunner(),
      clock: () => FIXED_NOW,
      logger: noopLogger,
    };
    const leaf = evaluatorLeaf(deps, task.id);
    const result = await leaf.execute(baseCtx(task));

    expectSelfBlock(result, 'schema');
    // Original + exactly one corrective retry — never loops.
    expect(mock.invocations).toHaveLength(2);
  });

  // ── Bounded loop (correctiveRetries=2): recover on the SECOND nudge / exhaust after two ──
  const vacuousPass: SpawnFixture = {
    kind: 'ok',
    payload: {
      schemaVersion: 1,
      signals: [
        {
          type: 'evaluation',
          status: 'passed',
          dimensions: [{ dimension: 'correctness', passed: true, finding: 'all good' }],
          timestamp: '2026-05-22T10:00:00.000Z',
        },
      ],
    },
  };
  const twoRetryDeps = (mock: ReturnType<typeof createMockHeadlessProvider>): EvaluatorLeafDeps => {
    const writeFile: EvaluatorLeafDeps['writeFile'] = async (path, content) => {
      await fs.mkdir(join(String(path), '..'), { recursive: true });
      await fs.writeFile(String(path), content, 'utf8');
      return Result.ok(undefined);
    };
    return {
      provider: mock.provider,
      templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
      publishSignal: createPublishSignal(createInMemoryEventBus(), 'evaluator'),
      writeFile,
      cwd: absolutePath('/tmp/ralph/fake-cwd'),
      sprintDir: absolutePath('/tmp/ralph/fake-sprint-dir'),
      progressFile: absolutePath('/tmp/ralph/fake-sprint-dir/progress.md'),
      model: 'test-model',
      plateauThreshold: 2,
      correctiveRetries: 2,
      gitRunner: stubGitRunner(),
      clock: () => FIXED_NOW,
      logger: noopLogger,
    };
  };

  it('corrective retry recovers on the SECOND nudge (correctiveRetries=2 → 3 spawns)', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    // Original + first nudge both write a vacuous PASS (fails the floor refinement); the second
    // nudge writes the full floor set → recovers.
    const sequences = new Map<string, readonly SpawnFixture[]>([
      [
        signalsFilePath(),
        [vacuousPass, vacuousPass, { kind: 'ok', payload: { schemaVersion: 1, signals: [passedEvaluation] } }],
      ],
    ]);
    const mock = createMockHeadlessProvider({ sequences });
    const leaf = evaluatorLeaf(twoRetryDeps(mock), task.id);
    const result = await leaf.execute(baseCtx(task));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.lastExit?.kind).toBe('passed');
    // Original spawn + 2 corrective nudges.
    expect(mock.invocations).toHaveLength(3);
  });

  it('corrective retry exhausted after two nudges (correctiveRetries=2 → 3 spawns) → self-block', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const sequences = new Map<string, readonly SpawnFixture[]>([
      [signalsFilePath(), [vacuousPass, vacuousPass, vacuousPass]],
    ]);
    const mock = createMockHeadlessProvider({ sequences });
    const leaf = evaluatorLeaf(twoRetryDeps(mock), task.id);
    const result = await leaf.execute(baseCtx(task));

    expectSelfBlock(result, 'schema');
    // Original spawn + 2 corrective nudges, then self-block.
    expect(mock.invocations).toHaveLength(3);
  });

  // ── Stale-clear: a self-blocked round must CLEAR a prior round's lastEvaluation ──
  // Regression guard: the output projection used to spread `lastEvaluation` conditionally, so a
  // signals-missing (self-blocked) round left the PRIOR round's verdict on `ctx.lastEvaluation`.
  // `settle-attempt` then wrote `outcome.md` attributing a stale verdict to the failing round.
  // The fix assigns `lastEvaluation: out.evaluation` directly, clearing it to `undefined`.
  it('self-blocked round clears the prior round lastEvaluation (no stale verdict carried)', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    // Round 1 succeeds against rounds/1/...; round 2 returns signals-missing against rounds/2/...
    const round1Signals = join(String(root.root), 'rounds', '1', 'evaluator', 'signals.json');
    const round2Signals = join(String(root.root), 'rounds', '2', 'evaluator', 'signals.json');
    const fixtures = new Map<string, SpawnFixture>([
      [round1Signals, { kind: 'ok', payload: { schemaVersion: 1, signals: [passedEvaluation] } }],
      [round2Signals, { kind: 'ok-missing' }],
    ]);
    const leaf = evaluatorLeaf(buildDeps(fixtures), task.id);

    // Round 1 — verdict lands on ctx.lastEvaluation.
    const round1 = await leaf.execute(baseCtx(task));
    expect(round1.ok).toBe(true);
    if (!round1.ok) return;
    expect(round1.value.ctx.lastEvaluation?.status).toBe('passed');

    // Round 2 — self-blocked, runs against the SAME threaded ctx with the round bumped.
    const round2 = await leaf.execute({ ...round1.value.ctx, currentRoundNum: 2 });
    expectSelfBlock(round2, 'signals-missing');
    if (!round2.ok) return;
    // The prior round's verdict MUST NOT survive into the failing round.
    expect(round2.value.ctx.lastEvaluation).toBeUndefined();
  });
});
