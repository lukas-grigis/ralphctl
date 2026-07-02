import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { AiSignalEvent, AppEvent } from '@src/business/observability/events.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { createInMemorySink } from '@tests/fixtures/in-memory-sink.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { absolutePath, FIXED_NOW, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import { createMockHeadlessProvider, type SpawnFixture } from '@tests/helpers/mock-headless-provider.ts';
import type { GeneratorLeafDeps } from '@src/application/flows/implement/leaves/generator.ts';
import { generatorLeaf } from '@src/application/flows/implement/leaves/generator.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Audit-[10] nine-branch grid against the audit-[09] generator contract.
 *
 * Each case constructs a tmpdir, points `signalsFile` at
 * `<root>/rounds/1/generator/signals.json`, registers one fixture against that exact path,
 * and asserts on the leaf's `Result`, the bus's `ai-signal` fan-out, and the on-disk
 * sidecar (`commit-message.txt`). The fake template loader renders the real implement
 * template so the leaf's pre-spawn prompt-write side effect lands in the expected dir.
 */

describe('generatorLeaf — audit-[09] contract', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;

  beforeEach(async () => {
    root = await makeTmpRoot();
  });

  afterEach(async () => {
    await root.cleanup();
  });

  const signalsFilePath = (): string => join(String(root.root), 'rounds', '1', 'generator', 'signals.json');
  const sidecarPath = (): string => join(String(root.root), 'rounds', '1', 'generator', 'commit-message.txt');

  /**
   * Build the leaf deps along with two inspectable handles — the in-memory sink (so tests
   * can read what the leaf emitted to the legacy fan-out) and the recorded mock provider
   * invocations. Returning the rich tuple keeps the test bodies free of casts.
   */
  const buildDeps = (
    fixtures: Map<string, SpawnFixture>,
    eventBus = createInMemoryEventBus()
  ): {
    readonly deps: GeneratorLeafDeps;
    readonly sink: ReturnType<typeof createInMemorySink<HarnessSignal>>;
  } => {
    const mock = createMockHeadlessProvider({ fixtures });
    // `WriteFile` adapter — real disk writes so sidecars land where the production helper
    // would write them and tests can read them back. No port mock needed.
    const writeFile: GeneratorLeafDeps['writeFile'] = async (path, content) => {
      try {
        await fs.mkdir(join(String(path), '..'), { recursive: true });
        await fs.writeFile(String(path), content, 'utf8');
        return Result.ok(undefined);
      } catch (cause) {
        return Result.error({ message: String(cause) } as never);
      }
    };
    const sink = createInMemorySink<HarnessSignal>();
    const deps: GeneratorLeafDeps = {
      provider: mock.provider,
      templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
      signals: sink,
      writeFile,
      cwd: absolutePath('/tmp/ralph/fake-cwd'),
      sprintDir: absolutePath('/tmp/ralph/fake-sprint-dir'),
      progressFile: absolutePath('/tmp/ralph/fake-sprint-dir/progress.md'),
      model: 'test-model',
      clock: () => FIXED_NOW,
      logger: noopLogger,
      eventBus,
      maxTurns: 5,
      plateauThreshold: 3,
      correctiveRetries: 2,
    };
    return { deps, sink };
  };

  const baseCtx = (task: ReturnType<typeof makeInProgressTaskWithRunningAttempt>): ImplementCtx => ({
    sprintId: task.id as unknown as ImplementCtx['sprintId'],
    tasks: [task],
    currentTask: task,
    progressFile: absolutePath(join(String(root.root), 'progress.md')),
    taskWorkspaceRoot: root.root,
    currentRoundNum: 1,
  });

  const captureBus = (eventBus = createInMemoryEventBus()): { events: AppEvent[]; eventBus: typeof eventBus } => {
    const events: AppEvent[] = [];
    eventBus.subscribe((e) => {
      events.push(e);
    });
    return { events, eventBus };
  };

  // ── 1. Happy path ─────────────────────────────────────────────────────────────
  it('ok: validates signals, writes commit-message.txt, fans out to bus + sink', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const fixtures = new Map<string, SpawnFixture>([
      [
        signalsFilePath(),
        {
          kind: 'ok',
          payload: {
            schemaVersion: 1,
            signals: [
              { type: 'change', text: 'added foo', timestamp: '2026-05-22T10:00:00.000Z' },
              { type: 'decision', text: 'use json on-disk', timestamp: '2026-05-22T10:00:00.500Z' },
              { type: 'learning', text: 'providers differ on flags', timestamp: '2026-05-22T10:00:00.750Z' },
              { type: 'note', text: 'follow-up: tighten log', timestamp: '2026-05-22T10:00:00.900Z' },
              { type: 'task-verified', output: 'tests pass', timestamp: '2026-05-22T10:00:01.000Z' },
              {
                type: 'commit-message',
                subject: 'feat(foo): bar',
                body: 'why this matters',
                timestamp: '2026-05-22T10:00:02.000Z',
              },
            ],
          },
        },
      ],
    ]);
    const { events, eventBus } = captureBus();
    const { deps, sink } = buildDeps(fixtures, eventBus);
    const leaf = generatorLeaf(deps, task.id);

    const result = await leaf.execute(baseCtx(task));
    expect(result.ok).toBe(true);

    // Sidecar exists with the expected body format: `<subject>\n\n<body>\n`.
    const sidecar = await fs.readFile(sidecarPath(), 'utf8');
    expect(sidecar).toBe('feat(foo): bar\n\nwhy this matters\n');

    // Bus fan-out: every validated signal carried as a typed `ai-signal` event.
    const aiSignals = events.filter((e): e is AiSignalEvent => e.type === 'ai-signal');
    expect(aiSignals.map((e) => e.signal.type)).toEqual([
      'change',
      'decision',
      'learning',
      'note',
      'task-verified',
      'commit-message',
    ]);
    for (const ev of aiSignals) expect(ev.source).toBe('generator');

    // The legacy sink still sees the same signals (TUI consumers stay happy until Wave 6).
    expect(sink.entries.map((s: HarnessSignal) => s.type)).toEqual([
      'change',
      'decision',
      'learning',
      'note',
      'task-verified',
      'commit-message',
    ]);

    // Ctx projection threads the validated commit-message into proposedCommitMessage.
    if (!result.ok) return;
    expect(result.value.ctx.proposedCommitMessage).toEqual({ subject: 'feat(foo): bar', body: 'why this matters' });

    // Per-attempt signal accumulators land on ctx so the journal leaf can render dedicated
    // `### Changes` / `### Decisions` / `### Learnings` / `### Notes` subsections.
    expect(result.value.ctx.currentAttemptChanges).toEqual(['added foo']);
    expect(result.value.ctx.currentAttemptDecisions).toEqual(['use json on-disk']);
    expect(result.value.ctx.currentAttemptLearnings).toEqual([{ text: 'providers differ on flags' }]);
    expect(result.value.ctx.currentAttemptNotes).toEqual(['follow-up: tighten log']);
  });

  // ── 6. Optional sidecar absent ────────────────────────────────────────────────
  it('ok without commit-message signal: leaf returns ok, no sidecar written', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const fixtures = new Map<string, SpawnFixture>([
      [
        signalsFilePath(),
        {
          kind: 'ok',
          payload: {
            schemaVersion: 1,
            signals: [{ type: 'note', text: 'investigating', timestamp: '2026-05-22T10:00:00.000Z' }],
          },
        },
      ],
    ]);
    const leaf = generatorLeaf(buildDeps(fixtures).deps, task.id);
    const result = await leaf.execute(baseCtx(task));
    expect(result.ok).toBe(true);

    // No sidecar file: optional multiplicity + no matching signal = no write.
    await expect(fs.access(sidecarPath())).rejects.toThrow();
  });

  // A recoverable signals-contract failure (missing / malformed / schema-mismatch / refinement)
  // no longer aborts the run via Result.error — the generator turn converts it into a
  // `self-blocked` exit so ONLY this task blocks. The leaf returns `Result.ok` with
  // `ctx.lastExit` / `ctx.lastBlockReason` set, and the precise validator message is preserved
  // in the block reason so the operator sees WHY the turn failed.
  const expectSelfBlock = (
    result: Awaited<ReturnType<ReturnType<typeof generatorLeaf>['execute']>>,
    messageFragment: string
  ): void => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.lastExit).toEqual({
      kind: 'self-blocked',
      reason: expect.stringContaining('generator did not produce a valid signals.json') as unknown as string,
    });
    expect(result.value.ctx.lastBlockReason).toContain(messageFragment);
  };

  // ── 2. signals.json missing ───────────────────────────────────────────────────
  it('ok-missing: self-blocks with signals-missing in the reason', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const fixtures = new Map<string, SpawnFixture>([[signalsFilePath(), { kind: 'ok-missing' }]]);
    const leaf = generatorLeaf(buildDeps(fixtures).deps, task.id);
    const result = await leaf.execute(baseCtx(task));
    expectSelfBlock(result, 'signals-missing');
  });

  // ── 3. Malformed JSON ─────────────────────────────────────────────────────────
  it('ok-raw with invalid JSON: self-blocks with malformed JSON in the reason', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const fixtures = new Map<string, SpawnFixture>([
      [signalsFilePath(), { kind: 'ok-raw', rawBody: '{ this is not json' }],
    ]);
    const leaf = generatorLeaf(buildDeps(fixtures).deps, task.id);
    const result = await leaf.execute(baseCtx(task));
    expectSelfBlock(result, 'malformed JSON');
  });

  // ── 4. Schema fails Zod (wrong shape) ─────────────────────────────────────────
  it('ok with evaluator-only signal: self-blocks with schema in the reason', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const fixtures = new Map<string, SpawnFixture>([
      [
        signalsFilePath(),
        {
          kind: 'ok',
          payload: {
            schemaVersion: 1,
            // `evaluation` is intentionally not part of the generator contract — the
            // evaluator emits it. A generator-side `evaluation` MUST be rejected.
            signals: [{ type: 'evaluation', status: 'passed', dimensions: [], timestamp: '2026-05-22T10:00:00.000Z' }],
          },
        },
      ],
    ]);
    const leaf = generatorLeaf(buildDeps(fixtures).deps, task.id);
    const result = await leaf.execute(baseCtx(task));
    expectSelfBlock(result, 'schema');
  });

  // ── 5. Schema fails refine (atMostOne commit-message) ─────────────────────────
  it('ok with two commit-message signals: refinement rejects → self-block', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const fixtures = new Map<string, SpawnFixture>([
      [
        signalsFilePath(),
        {
          kind: 'ok',
          payload: {
            schemaVersion: 1,
            signals: [
              { type: 'commit-message', subject: 'first', timestamp: '2026-05-22T10:00:00.000Z' },
              { type: 'commit-message', subject: 'second', timestamp: '2026-05-22T10:00:01.000Z' },
            ],
          },
        },
      ],
    ]);
    const leaf = generatorLeaf(buildDeps(fixtures).deps, task.id);
    const result = await leaf.execute(baseCtx(task));
    expectSelfBlock(result, 'at most one commit-message');
  });

  // ── 7 (migration). Legacy top-level-array shape ───────────────────────────────
  it('migrations[0] wraps legacy top-level array shape into { schemaVersion, signals }', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    // The payload is the bare array today's adapters write
    // (`JSON.stringify(parseHarnessSignals(...))`). The contract's migration step turns
    // this into `{ schemaVersion: 1, signals: [...] }` at validation time.
    const fixtures = new Map<string, SpawnFixture>([
      [
        signalsFilePath(),
        {
          kind: 'ok',
          payload: [
            { type: 'change', text: 'legacy shape', timestamp: '2026-05-22T10:00:00.000Z' },
            {
              type: 'commit-message',
              subject: 'feat: migrated',
              timestamp: '2026-05-22T10:00:01.000Z',
            },
          ],
        },
      ],
    ]);
    const { events, eventBus } = captureBus();
    const leaf = generatorLeaf(buildDeps(fixtures, eventBus).deps, task.id);

    const result = await leaf.execute(baseCtx(task));
    expect(result.ok).toBe(true);

    const aiSignals = events.filter((e): e is AiSignalEvent => e.type === 'ai-signal');
    expect(aiSignals.map((e) => e.signal.type)).toEqual(['change', 'commit-message']);

    // Subject-only commit-message renders as `<subject>\n`.
    const sidecar = await fs.readFile(sidecarPath(), 'utf8');
    expect(sidecar).toBe('feat: migrated\n');
  });

  // ── 8. Spawn error ────────────────────────────────────────────────────────────
  it('spawn-error: self-blocks the task with the spawn error message, no validation attempted', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const spawnError = new InvalidStateError({
      entity: 'provider',
      currentState: 'broken',
      attemptedAction: 'generate',
      message: 'simulated spawn failure',
    });
    const fixtures = new Map<string, SpawnFixture>([[signalsFilePath(), { kind: 'spawn-error', error: spawnError }]]);
    const leaf = generatorLeaf(buildDeps(fixtures).deps, task.id);

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
    const leaf = generatorLeaf(buildDeps(fixtures).deps, task.id);

    // The mock throws AbortError; the leaf primitive treats it as a DomainError (it has a
    // string `code`) and surfaces it via Result.error. The "transparent" contract is that
    // the error instance survives end-to-end without being swallowed or remapped.
    const result = await leaf.execute(baseCtx(task));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(AbortError);
  });
});
