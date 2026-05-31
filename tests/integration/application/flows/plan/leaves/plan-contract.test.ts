import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { TaskPlanSignal } from '@src/domain/signal.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import type { AiSignalEvent, AppEvent } from '@src/business/observability/events.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type { DraftSprint } from '@src/domain/entity/sprint.ts';
import { addTicket } from '@src/domain/entity/sprint.ts';
import { approveTicketRequirements } from '@src/domain/entity/ticket.ts';
import { FIXED_LATER, makeDraftSprint, makePendingTicket, makeProject } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type {
  InteractiveAiProvider,
  InteractiveAiProviderInput,
} from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { CallPlannerInteractiveDeps } from '@src/application/flows/plan/leaves/call-planner-interactive.ts';
import { callPlannerInteractiveLeaf } from '@src/application/flows/plan/leaves/call-planner-interactive.ts';
import type { PlanCtx } from '@src/application/flows/plan/ctx.ts';

/**
 * Audit-[10] nine-branch grid against the audit-[09] plan contract.
 *
 * Each case constructs a tmpdir, pre-writes a `signals.json` payload directly (skipping the
 * leaf's synth step) for the cases that need a specific shape, and asserts on the leaf's
 * `Result` + bus fan-out. Plan has no sidecars; nothing else should land on disk beyond
 * `signals.json`.
 */

describe('callPlannerInteractiveLeaf — audit-[09] contract', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;
  let project: Project;
  let sprint: DraftSprint;
  let ticketId: string;
  let projectPath: string;

  beforeEach(async () => {
    root = await makeTmpRoot();
    project = makeProject();
    projectPath = String(project.repositories[0]?.path);

    // Build a draft sprint with one approved ticket so `planSprintUseCase` can transition to
    // `planned` on the happy path.
    let s = makeDraftSprint();
    const pending = makePendingTicket({ title: 'Sample ticket' });
    const added = addTicket(s, pending);
    if (!added.ok) throw new Error('addTicket setup failed');
    s = added.value;
    const approved = approveTicketRequirements(s.tickets[0]!, '## requirements');
    if (!approved.ok) throw new Error('approve setup failed');
    sprint = {
      ...s,
      tickets: s.tickets.map((t, i) => (i === 0 ? approved.value : t)),
    };
    ticketId = String(approved.value.id);
  });

  afterEach(async () => {
    await root.cleanup();
  });

  const unitDir = (): string => join(String(root.root), 'plan', 'session-1');
  const promptFilePath = (): string => join(unitDir(), 'prompt.md');
  // audit-[09] post-Wave-6: the AI writes `signals.json` directly under the unit root.
  const outputFilePath = (): string => join(unitDir(), 'signals.json');
  const signalsFilePath = (): string => join(unitDir(), 'signals.json');

  const ensureUnitDir = async (): Promise<void> => {
    await fs.mkdir(unitDir(), { recursive: true });
  };

  const fakeAi = (behaviour: (input: InteractiveAiProviderInput) => Promise<void>): InteractiveAiProvider => ({
    async run(input) {
      await behaviour(input);
      return Result.ok({});
    },
  });

  const buildDeps = (
    provider: InteractiveAiProvider,
    eventBus = createInMemoryEventBus()
  ): CallPlannerInteractiveDeps => {
    const writeFile: CallPlannerInteractiveDeps['writeFile'] = async (path, content) => {
      try {
        await fs.mkdir(join(String(path), '..'), { recursive: true });
        await fs.writeFile(String(path), content, 'utf8');
        return Result.ok(undefined);
      } catch (cause) {
        return Result.error({ message: String(cause) } as never);
      }
    };
    return {
      interactiveAi: provider,
      runInTerminal: async (fn) => fn(),
      logger: noopLogger,
      writeFile,
      eventBus,
      clock: () => FIXED_LATER,
      model: 'claude-sonnet-4-6',
    };
  };

  const buildCtx = (): PlanCtx => {
    const unitRoot = AbsolutePath.parse(unitDir());
    const promptFile = AbsolutePath.parse(promptFilePath());
    const outputFile = AbsolutePath.parse(outputFilePath());
    if (!unitRoot.ok || !promptFile.ok || !outputFile.ok) throw new Error('path setup failed');
    return {
      sprintId: sprint.id,
      projectId: project.id,
      sprint,
      project,
      tasks: [],
      currentUnitRoot: unitRoot.value,
      currentPromptFile: promptFile.value,
      currentOutputFile: outputFile.value,
    };
  };

  const captureBus = (eventBus = createInMemoryEventBus()): { events: AppEvent[]; eventBus: typeof eventBus } => {
    const events: AppEvent[] = [];
    eventBus.subscribe((e) => {
      events.push(e);
    });
    return { events, eventBus };
  };

  const taskPlanSignal = (tasksJson: string): TaskPlanSignal => ({
    type: 'task-plan',
    tasksJson,
    timestamp: '2026-05-22T10:00:00.000Z' as TaskPlanSignal['timestamp'],
  });

  const validTasksJson = (): string =>
    JSON.stringify([
      {
        id: 'T1',
        name: 'Add CSV utility',
        ticketRef: ticketId,
        projectPath,
        steps: ['create util', 'write tests'],
        verificationCriteria: [
          { id: 'C1', assertion: 'util exported', check: 'manual' },
          { id: 'C2', assertion: 'tests pass', check: 'manual' },
        ],
      },
    ]);

  // ── 1. Happy path ─────────────────────────────────────────────────────────────
  it('ok: validates pre-written wrapper, parses tasks, transitions sprint, fans out to bus', async () => {
    await ensureUnitDir();
    await fs.writeFile(
      signalsFilePath(),
      JSON.stringify({
        schemaVersion: 1,
        signals: [
          { type: 'learning', text: 'planner notes', timestamp: '2026-05-22T10:00:00.000Z' },
          taskPlanSignal(validTasksJson()),
        ],
      }),
      'utf8'
    );
    const { events, eventBus } = captureBus();
    const provider = fakeAi(async () => {});
    const leaf = callPlannerInteractiveLeaf(buildDeps(provider, eventBus));

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(true);

    const aiSignals = events.filter((e): e is AiSignalEvent => e.type === 'ai-signal');
    expect(aiSignals.map((e) => e.signal.type)).toEqual(['learning', 'task-plan']);
    for (const ev of aiSignals) expect(ev.source).toBe('plan');

    if (!result.ok) return;
    expect(result.value.ctx.plannedTasks).toHaveLength(1);
    expect(result.value.ctx.sprint?.status).toBe('planned');
  });

  // ── 2. signals.json missing ───────────────────────────────────────────────────
  it('ok-missing: surfaces signals-missing as InvalidStateError', async () => {
    await ensureUnitDir();
    const provider = fakeAi(async () => {});
    const leaf = callPlannerInteractiveLeaf(buildDeps(provider));

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(InvalidStateError);
    expect(result.error.error.message).toContain('signals-missing');
  });

  // ── 3. Malformed JSON ─────────────────────────────────────────────────────────
  it('malformed JSON: surfaces ParseError(invalid-json)', async () => {
    await ensureUnitDir();
    await fs.writeFile(signalsFilePath(), '{ malformed json', 'utf8');
    const provider = fakeAi(async () => {});
    const leaf = callPlannerInteractiveLeaf(buildDeps(provider));

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(ParseError);
    expect(result.error.error.message).toContain('malformed JSON');
  });

  // ── 4. Schema fails Zod (wrong shape) ─────────────────────────────────────────
  it('ok with evaluator-only evaluation signal: surfaces ParseError(schema-mismatch)', async () => {
    await ensureUnitDir();
    await fs.writeFile(
      signalsFilePath(),
      JSON.stringify({
        schemaVersion: 1,
        // `evaluation` is intentionally not part of the plan contract — the evaluator emits
        // it. A plan-side `evaluation` MUST be rejected by Zod.
        signals: [{ type: 'evaluation', status: 'passed', dimensions: [], timestamp: '2026-05-22T10:00:00.000Z' }],
      }),
      'utf8'
    );
    const provider = fakeAi(async () => {});
    const leaf = callPlannerInteractiveLeaf(buildDeps(provider));

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(ParseError);
    expect(result.error.error.message).toContain('schema');
  });

  // ── 5a. Schema fails refine — zero task-plans ─────────────────────────────────
  it('ok with zero task-plan signals: refinement rejects', async () => {
    await ensureUnitDir();
    await fs.writeFile(
      signalsFilePath(),
      JSON.stringify({
        schemaVersion: 1,
        signals: [{ type: 'note', text: 'no plan here', timestamp: '2026-05-22T10:00:00.000Z' }],
      }),
      'utf8'
    );
    const provider = fakeAi(async () => {});
    const leaf = callPlannerInteractiveLeaf(buildDeps(provider));

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(ParseError);
    expect(result.error.error.message).toContain('exactly one task-plan');
  });

  // ── 5b. Schema fails refine — two task-plans ──────────────────────────────────
  it('ok with two task-plan signals: refinement rejects', async () => {
    await ensureUnitDir();
    await fs.writeFile(
      signalsFilePath(),
      JSON.stringify({
        schemaVersion: 1,
        signals: [taskPlanSignal(validTasksJson()), taskPlanSignal(validTasksJson())],
      }),
      'utf8'
    );
    const provider = fakeAi(async () => {});
    const leaf = callPlannerInteractiveLeaf(buildDeps(provider));

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(ParseError);
    expect(result.error.error.message).toContain('exactly one task-plan');
  });

  // ── 7. Legacy top-level-array migration ───────────────────────────────────────
  it('migrations[0] wraps legacy top-level array shape into the v1 envelope at load time', async () => {
    await ensureUnitDir();
    // In-flight pre-Wave-6 artifact on disk: a bare top-level `[task-plan]` array. The
    // contract's `migrations[0]` lifts it into `{ schemaVersion, signals }` at validation
    // time, so the leaf accepts the legacy shape without re-running the AI.
    await fs.writeFile(signalsFilePath(), JSON.stringify([taskPlanSignal(validTasksJson())]), 'utf8');
    const provider = fakeAi(async () => {});
    const { events, eventBus } = captureBus();
    const leaf = callPlannerInteractiveLeaf(buildDeps(provider, eventBus));

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(true);

    const aiSignals = events.filter((e): e is AiSignalEvent => e.type === 'ai-signal');
    expect(aiSignals.map((e) => e.signal.type)).toEqual(['task-plan']);

    if (!result.ok) return;
    expect(result.value.ctx.plannedTasks).toHaveLength(1);
    expect(result.value.ctx.sprint?.status).toBe('planned');
  });

  // ── 8. Spawn error ────────────────────────────────────────────────────────────
  it('spawn-error: leaf surfaces the spawn error, no validation attempted', async () => {
    await ensureUnitDir();
    const spawnError = new InvalidStateError({
      entity: 'provider',
      currentState: 'broken',
      attemptedAction: 'plan',
      message: 'simulated spawn failure',
    });
    const provider: InteractiveAiProvider = {
      async run() {
        return Result.error(spawnError);
      },
    };
    const leaf = callPlannerInteractiveLeaf(buildDeps(provider));

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBe(spawnError);
    await expect(fs.access(signalsFilePath())).rejects.toThrow();
  });

  // ── 9. Abort during spawn ─────────────────────────────────────────────────────
  it('abort: AbortError propagates transparently through the leaf', async () => {
    await ensureUnitDir();
    const provider: InteractiveAiProvider = {
      async run() {
        throw new AbortError({ elementName: 'mock-interactive', reason: 'aborted by fixture' });
      },
    };
    const leaf = callPlannerInteractiveLeaf(buildDeps(provider));

    const result = await leaf.execute(buildCtx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(AbortError);
  });
});
