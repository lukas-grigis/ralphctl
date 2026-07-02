import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import {
  recordRunningAttemptCritique,
  recordRunningAttemptWarning,
  startNextAttempt,
} from '@src/domain/entity/task-attempts.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { AppEvent, TaskRoundStartedEvent } from '@src/business/observability/events.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { createFakeAiProvider } from '@tests/fixtures/fake-ai-provider.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { createEventBusLogger } from '@src/business/observability/event-bus-logger.ts';
import { createPublishSignal } from '@src/application/flows/_shared/publish-signal.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { absolutePath, FIXED_LATER, FIXED_NOW, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import { failCurrentAttempt, recordTaskEscalation } from '@src/domain/entity/task-settle.ts';
import { escalationBannerId } from '@src/business/task/escalation-policy.ts';
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
    publishSignal: createPublishSignal(eventBus, 'generator'),
    // The contract-driven generator renders sidecars via the WriteFile port. The legacy
    // tests below cover the leaf's pre-spawn behaviour (prompt persistence, round-event
    // boundary) so a no-op writer is sufficient — the new audit-[10] grid lives in
    // generator-contract.test.ts and exercises the sidecar render path end-to-end.
    writeFile: async () => Result.ok(undefined),
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
  });

  const baseCtx = (task: ReturnType<typeof makeInProgressTaskWithRunningAttempt>): ImplementCtx => ({
    sprintId: task.id as unknown as ImplementCtx['sprintId'],
    tasks: [task],
    currentTask: task,
    progressFile: absolutePath(join(String(root.root), 'progress.md')),
    taskWorkspaceRoot: root.root,
    currentRoundNum: 1,
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

    // Round number now flows from `ctx.currentRoundNum` (resolved by the upstream
    // `resolve-round-num` leaf in production); the test feeds it directly.
    await fs.mkdir(join(String(root.root), 'rounds', '1', 'generator'), { recursive: true });

    const leaf = generatorLeaf(buildDeps(), task.id);
    const result = await leaf.execute({ ...baseCtx(task), currentRoundNum: 2 });
    expect(result.ok).toBe(true);

    const promptPath = join(String(root.root), 'rounds', '2', 'generator', 'prompt.md');
    const content = await fs.readFile(promptPath, 'utf8');
    expect(content).toContain('## Prior Critique');
    expect(content).toContain('Tests fail on the empty-string boundary');
  });

  it('injects the prior-learnings block into the full prompt when ctx.priorLearnings is present', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const leaf = generatorLeaf(buildDeps(), task.id);
    const result = await leaf.execute({
      ...baseCtx(task),
      priorLearnings: [
        {
          v: 1,
          id: 'abc123',
          text: 'this repo runs tests via a custom harness',
          appliesTo: 'test setup',
          repo: '/repo',
          repoName: 'repo',
          taskKind: 'feature',
          sprintId: 'sprint-prior',
          taskId: 'task-prior',
          timestamp: String(FIXED_NOW),
          promotedAt: null,
        },
      ],
    });
    expect(result.ok).toBe(true);

    const content = await fs.readFile(join(String(root.root), 'rounds', '1', 'generator', 'prompt.md'), 'utf8');
    expect(content).toContain('## Learnings from prior sprints');
    expect(content).toContain('this repo runs tests via a custom harness');
    expect(content).toContain('(applies to test setup)');
  });

  it('injects the dimension-trajectory block into prompt.md when ctx.plateauHistory shows a still-failing dimension', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const leaf = generatorLeaf(buildDeps(), task.id);
    const failed = (dims: readonly string[]) => ({
      evaluation: {
        type: 'evaluation' as const,
        status: 'failed' as const,
        dimensions: dims.map((d) => ({ dimension: d, passed: false, finding: 'x' })),
        timestamp: FIXED_NOW,
      },
    });
    const result = await leaf.execute({
      ...baseCtx(task),
      currentRoundNum: 2,
      plateauHistory: [failed(['correctness']), failed(['correctness'])],
    });
    expect(result.ok).toBe(true);

    const content = await fs.readFile(join(String(root.root), 'rounds', '2', 'generator', 'prompt.md'), 'utf8');
    expect(content).toContain('## Dimension trajectory');
    expect(content).toContain('correctness: STILL FAILING');
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
    // In production the upstream `resolve-round-num` leaf bumps `currentRoundNum` between
    // iterations; the test simulates that handoff.
    const second = await leaf.execute({ ...first.value.ctx, currentRoundNum: 2 });
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
      responses: { implement: '', 'implement-continuation': '' },
      sessionIds: {
        // Round 1 sends the full `implement` prompt; round 2 (resumed) sends the
        // `implement-continuation` prompt — script both so each round captures its own id.
        // Distinct ids per round so the assertion catches "wrong round id forwarded" bugs.
        implement: 'gen-r1',
        'implement-continuation': 'gen-r2',
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

    const second = await leaf.execute({ ...first.value.ctx, currentRoundNum: 2 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // Round 2: the leaf MUST forward round 1's captured id as the resume target.
    expect(provider.recordedSessions[1]?.resume).toBe('gen-r1');
    // After round 2, the latest captured id wins (and replaces the prior one in ctx).
    expect(second.value.ctx.priorGeneratorSessionId).toBe('gen-r2');
  });

  it('uses task.escalatedToModel as the spawn model when the task carries an escalation', async () => {
    const initial = makeInProgressTaskWithRunningAttempt();
    const stamped = recordTaskEscalation(initial, 'claude-sonnet-4-6', 'claude-opus-4-8');
    if (!stamped.ok) throw stamped.error;
    const task = stamped.value;
    const provider = createFakeAiProvider({ responses: { implement: '' } });
    const leaf = generatorLeaf({ ...buildDeps(), provider, model: 'claude-sonnet-4-6' }, task.id);
    const result = await leaf.execute(baseCtx(task));
    expect(result.ok).toBe(true);
    expect(provider.recordedSessions[0]?.model).toBe('claude-opus-4-8');
  });

  it('falls back to the configured model when the task has no escalatedToModel', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const provider = createFakeAiProvider({ responses: { implement: '' } });
    const leaf = generatorLeaf({ ...buildDeps(), provider, model: 'claude-sonnet-4-6' }, task.id);
    const result = await leaf.execute(baseCtx(task));
    expect(result.ok).toBe(true);
    expect(provider.recordedSessions[0]?.model).toBe('claude-sonnet-4-6');
  });

  // Plateau-break: when the escalation policy stamped the task (model bump or same-model nudge),
  // the generator must inject the "change your approach" directive into the prompt.
  it('injects the change-of-approach directive into prompt.md when the task is a plateau-break (escalated)', async () => {
    const initial = makeInProgressTaskWithRunningAttempt();
    // A same-model nudge (top-of-ladder) stamps escalatedFromModel — the directive arms on that
    // PLUS a stall-driven prior attempt: the last settled attempt must carry a plateau /
    // budget-exhausted warning (a malformed retry after a nudge must NOT re-inject the directive).
    const warned = recordRunningAttemptWarning(initial, { kind: 'plateau', dimensions: ['correctness'] });
    if (!warned.ok) throw warned.error;
    const settled = failCurrentAttempt(warned.value, FIXED_LATER, 'failed');
    if (!settled.ok) throw settled.error;
    if (settled.value.status !== 'in_progress') throw new Error('fixture: expected in_progress after fail');
    const reopened = startNextAttempt(settled.value, FIXED_LATER);
    if (!reopened.ok) throw reopened.error;
    const stamped = recordTaskEscalation(reopened.value, 'claude-opus-4-8', 'claude-opus-4-8');
    if (!stamped.ok) throw stamped.error;
    const leaf = generatorLeaf(buildDeps(), stamped.value.id);
    const result = await leaf.execute(baseCtx(stamped.value));
    expect(result.ok).toBe(true);

    const content = await fs.readFile(join(String(root.root), 'rounds', '1', 'generator', 'prompt.md'), 'utf8');
    expect(content).toContain('You have plateaued');
    expect(content).toContain('change your approach');
  });

  it('omits the directive on a malformed retry after a nudge — the new approach was never judged stalled', async () => {
    const initial = makeInProgressTaskWithRunningAttempt();
    // Prior attempt settled with a MALFORMED warning (the evaluator's failure) — even though the
    // nudge stamp persists on the task, the directive must not re-fire.
    const warned = recordRunningAttemptWarning(initial, { kind: 'malformed', detail: 'no verdict' });
    if (!warned.ok) throw warned.error;
    const settled = failCurrentAttempt(warned.value, FIXED_LATER, 'malformed');
    if (!settled.ok) throw settled.error;
    if (settled.value.status !== 'in_progress') throw new Error('fixture: expected in_progress after fail');
    const reopened = startNextAttempt(settled.value, FIXED_LATER);
    if (!reopened.ok) throw reopened.error;
    const stamped = recordTaskEscalation(reopened.value, 'claude-opus-4-8', 'claude-opus-4-8');
    if (!stamped.ok) throw stamped.error;
    const leaf = generatorLeaf(buildDeps(), stamped.value.id);
    await leaf.execute(baseCtx(stamped.value));
    const content = await fs.readFile(join(String(root.root), 'rounds', '1', 'generator', 'prompt.md'), 'utf8');
    expect(content).not.toContain('You have plateaued');
  });

  it('omits the change-of-approach directive when the task has not escalated', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const leaf = generatorLeaf(buildDeps(), task.id);
    await leaf.execute(baseCtx(task));
    const content = await fs.readFile(join(String(root.root), 'rounds', '1', 'generator', 'prompt.md'), 'utf8');
    expect(content).not.toContain('You have plateaued');
  });

  // On a model BUMP (from !== to) the directive is intentionally NOT armed — the stronger model
  // gets the targeted priorCritique, and the "abandon your approach" directive is reserved for the
  // top-of-ladder same-model nudge (from === to).
  it('omits the change-of-approach directive on a model bump (escalatedFromModel !== escalatedToModel)', async () => {
    const initial = makeInProgressTaskWithRunningAttempt();
    const stamped = recordTaskEscalation(initial, 'claude-sonnet-4-6', 'claude-opus-4-8');
    if (!stamped.ok) throw stamped.error;
    const leaf = generatorLeaf(buildDeps(), stamped.value.id);
    const result = await leaf.execute(baseCtx(stamped.value));
    expect(result.ok).toBe(true);
    const content = await fs.readFile(join(String(root.root), 'rounds', '1', 'generator', 'prompt.md'), 'utf8');
    expect(content).not.toContain('You have plateaued');
  });

  // Abort wire (keystone for #1/#5): the runner threads its AbortController signal into every
  // `element.execute(ctx, signal)`; the leaf framework forwards it as the 2nd arg of the
  // use-case `execute(input, signal)`. The generator must carry it onto the spawned session so
  // the headless provider arms its SIGTERM kill ladder. Before this wire the field was always
  // undefined and a manual abort let the child run to completion (stranding lock + spinner).
  it('threads the chain abort signal onto the spawned session so a cancel can kill the child', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const provider = createFakeAiProvider({ responses: { implement: '' } });
    const leaf = generatorLeaf({ ...buildDeps(), provider }, task.id);
    const controller = new AbortController();
    const result = await leaf.execute(baseCtx(task), controller.signal);
    expect(result.ok).toBe(true);
    expect(provider.recordedSessions[0]?.abortSignal).toBe(controller.signal);
  });

  it('leaves the session abortSignal undefined when the runner passes no signal', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const provider = createFakeAiProvider({ responses: { implement: '' } });
    const leaf = generatorLeaf({ ...buildDeps(), provider }, task.id);
    const result = await leaf.execute(baseCtx(task));
    expect(result.ok).toBe(true);
    expect(provider.recordedSessions[0]?.abortSignal).toBeUndefined();
  });

  it('publishes a banner-clear for the escalation banner when a new round starts', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const eventBus = createInMemoryEventBus();
    const events: AppEvent[] = [];
    eventBus.subscribe((e) => events.push(e));
    const leaf = generatorLeaf(buildDeps(eventBus), task.id);
    await leaf.execute(baseCtx(task));
    const clears = events.filter(
      (e): e is Extract<AppEvent, { type: 'banner-clear' }> =>
        e.type === 'banner-clear' && e.id === escalationBannerId(String(task.id))
    );
    expect(clears).toHaveLength(1);
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

  // Prompt selection by session continuity. The FIRST turn of a session thread (no prior id)
  // re-sends the full brief; a RESUMED turn (prior id present) sends the slim continuation
  // prompt. A provider that never reports a session id keeps getting the full prompt because the
  // discriminant — `priorGeneratorSessionId` — is the same field `--resume` consumes.
  describe('prompt selection by session continuity', () => {
    const readPrompt = async (round: number): Promise<string> =>
      fs.readFile(join(String(root.root), 'rounds', String(round), 'generator', 'prompt.md'), 'utf8');

    it('sends the FULL implement prompt on the first turn (no prior session id)', async () => {
      const task = makeInProgressTaskWithRunningAttempt();
      const leaf = generatorLeaf(buildDeps(), task.id);
      const result = await leaf.execute(baseCtx(task));
      expect(result.ok).toBe(true);

      const content = await readPrompt(1);
      expect(content).toContain('# Task Execution Protocol');
      expect(content).not.toContain('# Continue — Round');
    });

    it('sends the CONTINUATION prompt on a resumed turn (prior session id present)', async () => {
      // A provider that reports a session id so round 1 lands `priorGeneratorSessionId` on ctx.
      const provider = createFakeAiProvider({
        responses: { implement: '', 'implement-continuation': '' },
        sessionIds: { implement: 'gen-1' },
      });
      const task = makeInProgressTaskWithRunningAttempt();
      const leaf = generatorLeaf({ ...buildDeps(), provider }, task.id);

      const first = await leaf.execute(baseCtx(task));
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.value.ctx.priorGeneratorSessionId).toBe('gen-1');
      // Round 1 used the full brief.
      expect(await readPrompt(1)).toContain('# Task Execution Protocol');

      await fs.mkdir(join(String(root.root), 'rounds', '2', 'generator'), { recursive: true });
      const second = await leaf.execute({ ...first.value.ctx, currentRoundNum: 2 });
      expect(second.ok).toBe(true);

      // Round 2 resumed → the continuation prompt, which names the round and omits the full brief.
      const round2 = await readPrompt(2);
      expect(round2).toContain('# Continue — Round 2');
      expect(round2).not.toContain('# Task Execution Protocol');
    });

    it('always sends the FULL prompt when the provider never reports a session id', async () => {
      // No `sessionIds` configured → `priorGeneratorSessionId` is never set, so every round sends
      // the full prompt. This is the non-Claude-resume path (a provider that can't resume threads).
      const provider = createFakeAiProvider({ responses: { implement: '' } });
      const task = makeInProgressTaskWithRunningAttempt();
      const leaf = generatorLeaf({ ...buildDeps(), provider }, task.id);

      const first = await leaf.execute(baseCtx(task));
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.value.ctx.priorGeneratorSessionId).toBeUndefined();

      await fs.mkdir(join(String(root.root), 'rounds', '2', 'generator'), { recursive: true });
      const second = await leaf.execute({ ...first.value.ctx, currentRoundNum: 2 });
      expect(second.ok).toBe(true);

      // Both rounds carry the full brief — never the continuation prompt.
      expect(await readPrompt(1)).toContain('# Task Execution Protocol');
      expect(await readPrompt(2)).toContain('# Task Execution Protocol');
      expect(await readPrompt(2)).not.toContain('# Continue — Round');
    });
  });
});
