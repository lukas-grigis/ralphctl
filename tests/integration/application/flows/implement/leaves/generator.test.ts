import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import { recordRunningAttemptCritique } from '@src/domain/entity/task.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { AppEvent, TaskRoundStartedEvent } from '@src/business/observability/events.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { createInMemorySink } from '@tests/fixtures/in-memory-sink.ts';
import { createFakeAiProvider } from '@tests/fixtures/fake-ai-provider.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { createEventBusLogger } from '@src/business/observability/event-bus-logger.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { FIXED_NOW, absolutePath, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { generatorLeaf } from '@src/application/flows/implement/leaves/generator.ts';

describe('generatorLeaf', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;

  beforeEach(async () => {
    root = await makeTmpRoot();
  });

  afterEach(async () => {
    await root.cleanup();
  });

  const buildDeps = (eventBus = createInMemoryEventBus()) => ({
    provider: createFakeAiProvider({ responses: { implement: '' } }),
    templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
    signals: createInMemorySink<HarnessSignal>(),
    // The contract-driven generator renders sidecars via the WriteFile port. The legacy
    // tests below cover the leaf's pre-spawn behaviour (prompt persistence, round-event
    // boundary) so a no-op writer is sufficient — the new audit-[10] grid lives in
    // generator-contract.test.ts and exercises the sidecar render path end-to-end.
    writeFile: async () => Result.ok(undefined),
    cwd: absolutePath('/tmp/ralph/fake-cwd'),
    sprintDir: absolutePath('/tmp/ralph/fake-sprint-dir'),
    model: 'test-model',
    clock: () => FIXED_NOW,
    logger: noopLogger,
    eventBus,
    maxTurns: 5,
  });

  const baseCtx = (task: ReturnType<typeof makeInProgressTaskWithRunningAttempt>): ImplementCtx => ({
    sprintId: task.id as unknown as ImplementCtx['sprintId'],
    tasks: [task],
    currentTask: task,
    progressFile: absolutePath(join(String(root.root), 'progress.md')),
    taskWorkspaceRoot: root.root,
  });

  it('persists generator prompt.md under rounds/<N>/generator/ on round 1', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const leaf = generatorLeaf(buildDeps(), task.id);
    const result = await leaf.execute(baseCtx(task));
    expect(result.ok).toBe(true);

    const promptPath = join(String(root.root), 'rounds', '1', 'generator', 'prompt.md');
    const content = await fs.readFile(promptPath, 'utf8');
    expect(content).toContain(task.name);
    // Marker line from the implement template — proves a fully-rendered prompt is on disk.
    expect(content).toContain('# Task Execution Protocol');
  });

  it('persists round 2 prompt with the prior critique injected', async () => {
    const base = makeInProgressTaskWithRunningAttempt();
    const critiqued = recordRunningAttemptCritique(
      base,
      'Tests fail on the empty-string boundary; cover it before re-submitting.'
    );
    expect(critiqued.ok).toBe(true);
    if (!critiqued.ok) return;
    const task = critiqued.value;

    // Pre-create rounds/1/ so `nextRoundNum` returns 2.
    await fs.mkdir(join(String(root.root), 'rounds', '1', 'generator'), { recursive: true });

    const leaf = generatorLeaf(buildDeps(), task.id);
    const result = await leaf.execute(baseCtx(task));
    expect(result.ok).toBe(true);

    const promptPath = join(String(root.root), 'rounds', '2', 'generator', 'prompt.md');
    const content = await fs.readFile(promptPath, 'utf8');
    expect(content).toContain('## Prior Critique');
    expect(content).toContain('Tests fail on the empty-string boundary');
  });

  it('writes prompt.md atomically — no .tmp leftover on the target dir', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const leaf = generatorLeaf(buildDeps(), task.id);
    await leaf.execute(baseCtx(task));

    const dir = join(String(root.root), 'rounds', '1', 'generator');
    const entries = await fs.readdir(dir);
    expect(entries).toContain('prompt.md');
    expect(entries.filter((e) => e.includes('.tmp.'))).toEqual([]);
  });

  it('emits task-round-started with the current round, attempt, and totalCap', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const eventBus = createInMemoryEventBus();
    const events: AppEvent[] = [];
    eventBus.subscribe((e) => {
      events.push(e);
    });
    const leaf = generatorLeaf({ ...buildDeps(eventBus), maxTurns: 7 }, task.id);
    await leaf.execute(baseCtx(task));

    const rounds = events.filter((e): e is TaskRoundStartedEvent => e.type === 'task-round-started');
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({
      type: 'task-round-started',
      taskId: String(task.id),
      attemptN: 1,
      roundN: 1,
      totalCap: 7,
    });
  });

  it('emits a synthesised log event for the recent-events tail', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const eventBus = createInMemoryEventBus();
    const events: AppEvent[] = [];
    eventBus.subscribe((e) => {
      events.push(e);
    });
    // Real event-bus logger so the leaf's `logger.named('task.round-started').info(...)` call
    // surfaces as a `log` AppEvent — matches production wiring (`wire()` always passes the
    // bus logger).
    const logger = createEventBusLogger({ eventBus, clock: IsoTimestamp.now });
    const leaf = generatorLeaf({ ...buildDeps(eventBus), logger }, task.id);
    await leaf.execute(baseCtx(task));

    const logs = events.filter((e) => e.type === 'log' && e.message.includes('round 1/5 of attempt 1'));
    expect(logs.length).toBeGreaterThan(0);
  });

  it('emits monotonic round numbers across two iterations of the same task', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const eventBus = createInMemoryEventBus();
    const events: AppEvent[] = [];
    eventBus.subscribe((e) => {
      events.push(e);
    });
    const leaf = generatorLeaf(buildDeps(eventBus), task.id);

    const first = await leaf.execute(baseCtx(task));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // The leaf's `output` projection threads `currentTask`/`genEvalTurn`/`currentRoundNum`.
    // Use it as the next call's ctx — that's exactly what the surrounding loop does.
    const second = await leaf.execute(first.value.ctx);
    expect(second.ok).toBe(true);

    const rounds = events.filter((e): e is TaskRoundStartedEvent => e.type === 'task-round-started');
    expect(rounds.map((r) => r.roundN)).toEqual([1, 2]);
  });

  it("threads the captured generator sessionId across rounds: round 2 forwards round 1's id as session.resume", async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const eventBus = createInMemoryEventBus();
    // Per-round sessionIds: round 1 reports "gen-r1"; round 2 (resume) reports "gen-r1" again
    // (Claude returns the same session_id on a resume — and even if it didn't, the contract is
    // "whatever the adapter wrote to disk is what gets resumed next"). The point of the test is
    // that the SECOND call's session.resume matches the FIRST call's captured id.
    const provider = createFakeAiProvider({
      responses: { implement: '' },
      sessionIds: {
        implement: (session) =>
          // Distinct ids per round so the assertion catches "wrong round id forwarded" bugs.
          session.resume === undefined ? 'gen-r1' : 'gen-r2',
      },
    });
    const leaf = generatorLeaf({ ...buildDeps(eventBus), provider }, task.id);

    const first = await leaf.execute(baseCtx(task));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Round 1: no prior id → resume must be absent on the session descriptor.
    expect(provider.recordedSessions[0]?.resume).toBeUndefined();
    // Round 1's captured id lands on ctx so the next round can pick it up.
    expect(first.value.ctx.priorGeneratorSessionId).toBe('gen-r1');

    const second = await leaf.execute(first.value.ctx);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // Round 2: the leaf MUST forward round 1's captured id as the resume target.
    expect(provider.recordedSessions[1]?.resume).toBe('gen-r1');
    // After round 2, the latest captured id wins (and replaces the prior one in ctx).
    expect(second.value.ctx.priorGeneratorSessionId).toBe('gen-r2');
  });

  it('publishes the round event regardless of the AI call outcome (event fires before the call)', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const eventBus = createInMemoryEventBus();
    const events: AppEvent[] = [];
    eventBus.subscribe((e) => {
      events.push(e);
    });
    const deps = {
      ...buildDeps(eventBus),
      // Provider that fails — the boundary event must still fire because it is emitted
      // BEFORE `consumeSignals(...)` runs.
      provider: {
        async generate() {
          return Result.error(
            new InvalidStateError({
              entity: 'provider',
              currentState: 'broken',
              attemptedAction: 'generate',
              message: 'simulated provider error',
            })
          );
        },
      } as unknown as ReturnType<typeof createFakeAiProvider>,
    };
    const leaf = generatorLeaf(deps, task.id);
    await leaf.execute(baseCtx(task));

    const rounds = events.filter((e) => e.type === 'task-round-started');
    expect(rounds).toHaveLength(1);
  });
});
