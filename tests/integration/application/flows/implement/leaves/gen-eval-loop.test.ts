import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import type { AppEvent } from '@src/business/observability/events.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import { createFakeAiProvider } from '@tests/fixtures/fake-ai-provider.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { absolutePath, FIXED_NOW, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { createGenEvalLoop } from '@src/application/flows/implement/leaves/gen-eval-loop.ts';
import type { Element } from '@src/application/chain/element.ts';

/**
 * Loop-entry guard regression. When a terminal exit is ALREADY on ctx (the pre-task-verify
 * hard-block case — non-interactive red baseline / operator skip), the gen-eval loop's
 * `shouldContinue` must refuse to enter any turn: no round folder claimed, no meta sidecar
 * stamped, and crucially ZERO generator/evaluator spawns on the broken tree the gate refused
 * (the most expensive unit in the system).
 */
describe('createGenEvalLoop — loop-entry guard', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;

  beforeEach(async () => {
    root = await makeTmpRoot();
  });

  afterEach(async () => {
    await root.cleanup();
  });

  const buildLoop = () => {
    const generatorProvider = createFakeAiProvider({ responses: { implement: '' } });
    const evaluatorProvider = createFakeAiProvider({ responses: { evaluate: '' } });
    const task = makeInProgressTaskWithRunningAttempt();
    const loop = createGenEvalLoop(
      {
        generatorProvider,
        evaluatorProvider,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        publishSignal: () => {},
        writeFile: async () => Result.ok(undefined),
        clock: () => FIXED_NOW,
        logger: noopLogger,
        eventBus: createInMemoryEventBus(),
        readConfig: async () => ({ maxTurns: 5 }),
        maxTurns: 5,
        plateauThreshold: 2,
        correctiveRetries: 2, // Stub git runner — the guard refuses loop entry before any turn, so the plateau
        // fingerprint call never fires; a clean-tree response keeps it inert if it ever did.
        gitRunner: {
          async run() {
            return Result.ok({ stdout: '', stderr: '', exitCode: 0 });
          },
        },
      },
      {
        cwd: absolutePath('/tmp/ralph/fake-cwd'),
        sprintDir: root.root,
        progressFile: absolutePath('/tmp/ralph/fake-sprint-dir/progress.md'),
        generator: { providerId: 'codex', model: 'test-gen-model' },
        evaluator: { providerId: 'codex', model: 'test-eval-model' },
      },
      task.id
    );
    return { loop, generatorProvider, evaluatorProvider, task };
  };

  it('refuses to enter any turn when ctx.lastExit is already set — zero generator/evaluator spawns', async () => {
    const { loop, generatorProvider, evaluatorProvider, task } = buildLoop();
    const ctx: ImplementCtx = {
      sprintId: task.id as unknown as ImplementCtx['sprintId'],
      tasks: [task],
      currentTask: task,
      taskWorkspaceRoot: root.root,
      // The pre-task-verify hard-block already stamped a self-blocked exit before the loop runs.
      lastExit: { kind: 'self-blocked', reason: 'baseline already red at task start (non-interactive)' },
      lastBlockReason: 'baseline already red at task start (non-interactive)',
    };

    const result = await loop.execute(ctx);

    expect(result.ok).toBe(true);
    // The body never executed — neither role's provider was spawned.
    expect(generatorProvider.recordedSessions).toHaveLength(0);
    expect(evaluatorProvider.recordedSessions).toHaveLength(0);
    if (result.ok) {
      // ctx threads through untouched — the exit the gate set still drives finalize/settle.
      expect(result.value.ctx.lastExit).toEqual(ctx.lastExit);
      // No turn ran, so the turn counter stays unset (the zero-turn discriminant downstream).
      expect(result.value.ctx.genEvalTurn).toBeUndefined();
    }
  });
});

// ── Helpers shared across the shape-fence and behavioral tests ────────────────────────────────

interface ShapeNode {
  readonly name: string;
  readonly children?: readonly ShapeNode[];
}

const snapshot = <TCtx>(element: Element<TCtx>): ShapeNode => {
  const kids = element.children;
  return {
    name: element.name,
    ...(kids !== undefined ? { children: kids.map((c) => snapshot(c)) } : {}),
  };
};

const findByName = (node: ShapeNode, target: string): ShapeNode | undefined => {
  if (node.name === target) return node;
  for (const c of node.children ?? []) {
    const hit = findByName(c, target);
    if (hit !== undefined) return hit;
  }
  return undefined;
};

// ── Shape-fence tests ─────────────────────────────────────────────────────────────────────────

/**
 * Invariant (gen-eval-loop.ts:41-42): both attribution sidecars land BEFORE the spawn so that
 * crash-attribution survives a mid-spawn failure (signals.json may be absent; the meta files
 * name the provider regardless). The serial-shape fence on `flow-shape.test.ts` cannot detect a
 * reorder inside createGenEvalLoop because it reconstructs the same factory on both sides — both
 * sides move together. This fence asserts the LITERAL child order by name, catching any swap.
 */
describe('createGenEvalLoop — gen-eval-turn child order (step-order fence)', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;

  beforeEach(async () => {
    root = await makeTmpRoot();
  });

  afterEach(async () => {
    await root.cleanup();
  });

  const buildLoopShape = () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const loop = createGenEvalLoop(
      {
        generatorProvider: createFakeAiProvider({}),
        evaluatorProvider: createFakeAiProvider({}),
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        publishSignal: () => {},
        writeFile: async () => Result.ok(undefined),
        clock: () => FIXED_NOW,
        logger: noopLogger,
        eventBus: createInMemoryEventBus(),
        readConfig: async () => ({ maxTurns: 5 }),
        maxTurns: 5,
        plateauThreshold: 2,
        correctiveRetries: 2,
        gitRunner: {
          async run() {
            return Result.ok({ stdout: '', stderr: '', exitCode: 0 });
          },
        },
      },
      {
        cwd: absolutePath('/tmp/ralph/fake-cwd'),
        sprintDir: root.root,
        progressFile: absolutePath('/tmp/ralph/fake-sprint-dir/progress.md'),
        generator: { providerId: 'claude-code', model: 'claude-opus-4-8' },
        evaluator: { providerId: 'claude-code', model: 'claude-opus-4-8' },
      },
      task.id
    );
    return { loop, task };
  };

  it('gen-eval-turn children are [resolve-round-num, stamp-meta-generator, stamp-role-meta-generator, generator-leaf, evaluator-guard] in that order', () => {
    const { loop, task } = buildLoopShape();
    const id = String(task.id);

    // Loop wraps one sequential body.
    const shape = snapshot(loop);
    expect(shape.name).toBe(`gen-eval-${id}`);
    const turnSeq = shape.children?.[0];
    expect(turnSeq?.name).toBe(`gen-eval-turn-${id}`);

    const turnChildren = turnSeq?.children ?? [];
    const names = turnChildren.map((c) => c.name);

    // Exact order — sidecars precede the spawn.
    expect(names).toStrictEqual([
      `resolve-round-num-${id}`,
      `stamp-meta-generator-${id}`,
      `stamp-role-meta-generator-${id}`,
      `generator-${id}`,
      `evaluator-guard-${id}`,
    ]);
  });

  it('evaluator-guard body is [stamp-meta-evaluator, stamp-role-meta-evaluator, evaluator-leaf, loop-diversity-check, entropy-check] in that order', () => {
    const { loop, task } = buildLoopShape();
    const id = String(task.id);

    const shape = snapshot(loop);
    const turnSeq = shape.children?.[0];
    const guardNode = findByName(turnSeq ?? shape, `evaluator-guard-${id}`);
    expect(guardNode).toBeDefined();

    // guard.children = [body]; body is `evaluator-step-<id>` sequential.
    const evalStep = guardNode?.children?.[0];
    expect(evalStep?.name).toBe(`evaluator-step-${id}`);

    const evalChildren = evalStep?.children ?? [];
    const names = evalChildren.map((c) => c.name);

    expect(names).toStrictEqual([
      `stamp-meta-evaluator-${id}`,
      `stamp-role-meta-evaluator-${id}`,
      `evaluator-${id}`,
      `loop-diversity-check-${id}`,
      `entropy-check-${id}`,
    ]);
  });
});

// ── Behavioral test: crash-attribution guarantee ──────────────────────────────────────────────

/**
 * The crash-attribution invariant: when the generator spawn itself fails, meta.json and
 * role-meta.json must ALREADY exist on disk — the sidecars land before the spawn, not after.
 * This test exercises the invariant end-to-end: meta files exist even when the provider errors.
 */
describe('createGenEvalLoop — crash-attribution: meta sidecars land before generator spawn', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;

  beforeEach(async () => {
    root = await makeTmpRoot();
  });

  afterEach(async () => {
    await root.cleanup();
  });

  it('generator/meta.json and role-meta.json exist on disk even when the generator provider returns an error', async () => {
    const task = makeInProgressTaskWithRunningAttempt();

    // Provider that always returns a non-fatal (recoverable) InvalidStateError — simulates a
    // spawn failure whose error code is not Aborted/RateLimit. The `turn-error-policy` converts
    // this to a self-blocked exit rather than aborting the run. The loop therefore returns ok,
    // but both attribution sidecars MUST already be on disk (they stamp before the spawn).
    const failingGeneratorProvider = {
      async generate() {
        return Result.error(
          new InvalidStateError({
            entity: 'fake-provider',
            currentState: 'spawned',
            attemptedAction: 'generate',
            message: 'simulated generator spawn error for crash-attribution test',
          })
        );
      },
    };

    const loop = createGenEvalLoop(
      {
        generatorProvider: failingGeneratorProvider,
        evaluatorProvider: createFakeAiProvider({}),
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        publishSignal: () => {},
        // Real writeFile so the stamp sidecars actually land on disk.
        writeFile: createAtomicWriteFile(),
        clock: () => FIXED_NOW,
        logger: noopLogger,
        eventBus: createInMemoryEventBus(),
        readConfig: async () => ({ maxTurns: 5 }),
        maxTurns: 5,
        plateauThreshold: 2,
        correctiveRetries: 2,
        gitRunner: {
          async run() {
            return Result.ok({ stdout: '', stderr: '', exitCode: 0 });
          },
        },
      },
      {
        cwd: absolutePath('/tmp/ralph/fake-cwd'),
        sprintDir: root.root,
        progressFile: absolutePath('/tmp/ralph/fake-sprint-dir/progress.md'),
        generator: { providerId: 'claude-code', model: 'claude-opus-4-8' },
        evaluator: { providerId: 'claude-code', model: 'claude-opus-4-8' },
      },
      task.id
    );

    const ctx: ImplementCtx = {
      sprintId: task.id as unknown as ImplementCtx['sprintId'],
      tasks: [task],
      currentTask: task,
      taskWorkspaceRoot: root.root,
      // No lastExit — loop must enter and run the turn (which will fail at the generator spawn).
    };

    const result = await loop.execute(ctx);

    // A recoverable provider error converts to a self-blocked exit (not a fatal loop error);
    // the loop resolves ok with lastExit === self-blocked.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ctx.lastExit?.kind).toBe('self-blocked');
    }

    // Crash-attribution guarantee: meta.json and role-meta.json must already be on disk for
    // round 1, generator role — they were stamped before the spawn attempt.
    const round1GenDir = join(String(root.root), 'rounds', '1', 'generator');
    const metaExists = await fs
      .access(join(round1GenDir, 'meta.json'))
      .then(() => true)
      .catch(() => false);
    const roleMetaExists = await fs
      .access(join(round1GenDir, 'role-meta.json'))
      .then(() => true)
      .catch(() => false);

    expect(metaExists, 'rounds/1/generator/meta.json must exist before spawn (crash-attribution)').toBe(true);
    expect(roleMetaExists, 'rounds/1/generator/role-meta.json must exist before spawn (crash-attribution)').toBe(true);
  });
});

// ── Behavioral test: entropy-check fires on a signal-kind-distribution plateau (R2) ───────────

/**
 * The entropy-check leaf is now LIVE (no longer dormant): the generator leaf stamps each turn's
 * signal-kind distribution onto `ctx.lastTurnActionCounts`, and the entropy guard reads it as a
 * proxy for action diversity. These tests drive the real loop so the wiring is exercised
 * end-to-end, NOT a hand-fed input projection.
 *
 * To ISOLATE the entropy guard from the other two plateau sources that run first:
 *  - the R1 fingerprint guard (loop-diversity-check): the scripted evaluator fails a DIFFERENT
 *    floor dimension every turn, so the failure fingerprints stay diverse and it never fires.
 *  - the evaluator's own count-based plateau predicate: the scripted critique is genuinely
 *    dissimilar every turn, so the critique-shift exemption returns `progress` and it never fires
 *    (the same technique the e2e "exhausted budget" test relies on).
 * That leaves the entropy guard as the only possible plateau exit.
 */
describe('createGenEvalLoop — entropy-check (R2) live behavior', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;

  beforeEach(async () => {
    root = await makeTmpRoot();
  });

  afterEach(async () => {
    await root.cleanup();
  });

  const ts = FIXED_NOW;
  const taskVerified = (output: string): HarnessSignal => ({ type: 'task-verified', output, timestamp: ts });
  const note = (text: string): HarnessSignal => ({ type: 'note', text, timestamp: ts });
  const decision = (text: string): HarnessSignal => ({ type: 'decision', text, timestamp: ts });
  const change = (text: string): HarnessSignal => ({ type: 'change', text, timestamp: ts });
  const learning = (text: string): HarnessSignal => ({ type: 'learning', text, timestamp: ts });

  const FLOOR = ['correctness', 'completeness', 'safety', 'consistency', 'robustness'] as const;
  // Pairwise-dissimilar critiques (trigram-Jaccard < 0.5) so the evaluator's critique-shift
  // exemption keeps returning `progress` and its count-based plateau never fires.
  const CRITIQUES = [
    'first round complaint about a parser edge case in the tokenizer module',
    'second turn raises a completely different retry-semantics concern entirely',
    'third pass flags a SQL injection vector in the dynamic query builder layer',
    'fourth review worries about timezone handling around daylight-saving boundaries',
    'fifth look questions the cache eviction policy under sustained memory pressure',
  ];
  /**
   * A FAILED verdict for turn `i` (0-indexed): the single failing dimension ROTATES (diverse
   * fingerprints → loop-diversity stays quiet) and the critique is distinct (critique-shift
   * exemption → the count-based evaluator plateau stays quiet).
   */
  const failTurn = (i: number): HarnessSignal => {
    const failing = FLOOR[i % FLOOR.length] ?? 'correctness';
    return {
      type: 'evaluation',
      status: 'failed',
      dimensions: FLOOR.map((d) => ({ dimension: d, passed: d !== failing, finding: d === failing ? 'nope' : 'ok' })),
      critique: CRITIQUES[i] ?? `fallback critique number ${String(i)} mentioning unique token ${String(i * 7919)}`,
      timestamp: ts,
    };
  };

  const buildEntropyLoop = (opts: {
    readonly generatorSignals: readonly HarnessSignal[];
    readonly maxTurns: number;
    readonly eventBus: ReturnType<typeof createInMemoryEventBus>;
  }) => {
    const generatorProvider = createFakeAiProvider({
      responses: { implement: '' },
      signals: { implement: opts.generatorSignals },
    });
    // Rotate the failing dimension + critique per evaluate call (keeps loop-diversity AND the
    // evaluator's count-based plateau both quiet — see the failTurn docstring).
    let evalTurn = 0;
    const evaluatorProvider = createFakeAiProvider({
      responses: { evaluate: '' },
      signals: {
        evaluate: () => {
          const sig = failTurn(evalTurn);
          evalTurn += 1;
          return [sig];
        },
      },
    });
    const task = makeInProgressTaskWithRunningAttempt();
    const loop = createGenEvalLoop(
      {
        generatorProvider,
        evaluatorProvider,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        publishSignal: () => {},
        writeFile: async () => Result.ok(undefined),
        clock: () => FIXED_NOW,
        logger: noopLogger,
        eventBus: opts.eventBus,
        readConfig: async () => ({ maxTurns: opts.maxTurns }),
        maxTurns: opts.maxTurns,
        plateauThreshold: 2,
        correctiveRetries: 2,
        gitRunner: {
          async run() {
            return Result.ok({ stdout: '', stderr: '', exitCode: 0 });
          },
        },
      },
      {
        cwd: absolutePath('/tmp/ralph/fake-cwd'),
        sprintDir: root.root,
        progressFile: absolutePath('/tmp/ralph/fake-sprint-dir/progress.md'),
        generator: { providerId: 'claude-code', model: 'claude-opus-4-8' },
        evaluator: { providerId: 'claude-code', model: 'claude-opus-4-8' },
      },
      task.id
    );
    return { loop, task };
  };

  const ctxFor = (task: ReturnType<typeof makeInProgressTaskWithRunningAttempt>): ImplementCtx => ({
    sprintId: task.id as unknown as ImplementCtx['sprintId'],
    tasks: [task],
    currentTask: task,
    taskWorkspaceRoot: root.root,
  });

  it('exits with a plateau when the generator collapses to a single signal kind for >= window turns (budget remaining)', async () => {
    const eventBus = createInMemoryEventBus();
    const banners: AppEvent[] = [];
    eventBus.subscribe((e) => {
      if (e.type === 'banner-show') banners.push(e);
    });
    // Single narrative kind every turn → H = 0 (< 0.25). maxTurns = 5 leaves budget at turn 3.
    const { loop, task } = buildEntropyLoop({
      generatorSignals: [taskVerified('ok'), note('same kind of move')],
      maxTurns: 5,
      eventBus,
    });

    const result = await loop.execute(ctxFor(task));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The entropy guard reuses the plateau exit kind so the escalation ladder applies the remedy.
    expect(result.value.ctx.lastExit?.kind).toBe('plateau');
    // Fires exactly at the window boundary (turn 3 = DIVERSITY_WINDOW_SIZE), with budget remaining.
    expect(result.value.ctx.genEvalTurn).toBe(3);
    const entropyBanner = banners.find(
      (e) => e.type === 'banner-show' && e.id === `entropy-plateau-${String(task.id)}`
    );
    expect(entropyBanner).toBeDefined();
    if (entropyBanner?.type === 'banner-show') expect(entropyBanner.cause).toBe('low-action-entropy');
  });

  it('does NOT exit when the generator emits a diverse spread of signal kinds (high entropy)', async () => {
    const eventBus = createInMemoryEventBus();
    const banners: AppEvent[] = [];
    eventBus.subscribe((e) => {
      if (e.type === 'banner-show') banners.push(e);
    });
    // One of each narrative kind every turn → uniform 4-kind distribution → H = 1 (no plateau).
    const { loop, task } = buildEntropyLoop({
      generatorSignals: [taskVerified('ok'), decision('d'), change('c'), learning('l'), note('n')],
      maxTurns: 4,
      eventBus,
    });

    const result = await loop.execute(ctxFor(task));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // High entropy + diverse fingerprints → neither guard fires; the loop runs to its budget and
    // leaves `lastExit` for finalize to synthesise (budget-exhausted) downstream.
    expect(result.value.ctx.lastExit).toBeUndefined();
    expect(result.value.ctx.genEvalTurn).toBe(4);
    const entropyBanner = banners.find(
      (e) => e.type === 'banner-show' && e.id === `entropy-plateau-${String(task.id)}`
    );
    expect(entropyBanner).toBeUndefined();
  });
});
