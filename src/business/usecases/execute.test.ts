/**
 * Focused regression tests for ExecuteTasksUseCase's per-task config read
 * (REQ-12 — live config). Integration behaviour is covered by CLI tests;
 * these tests exercise only the behaviour the requirement introduced.
 */

import { describe, expect, it, vi } from 'vitest';
import { ExecuteTasksUseCase } from './execute.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { AiSessionPort } from '@src/business/ports/ai-session.ts';
import type { PromptBuilderPort } from '@src/business/ports/prompt-builder.ts';
import type { OutputParserPort } from '@src/business/ports/output-parser.ts';
import type { UserInteractionPort } from '@src/business/ports/user-interaction.ts';
import type { LoggerPort } from '@src/business/ports/logger.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import type { FilesystemPort } from '@src/business/ports/filesystem.ts';
import type { SignalParserPort } from '@src/business/ports/signal-parser.ts';
import type { SignalHandlerPort } from '@src/business/ports/signal-handler.ts';
import type { HarnessEvent, SignalBusPort } from '@src/business/ports/signal-bus.ts';
import type { Sprint } from '@src/domain/models.ts';

function makePersistenceWithGetConfig(values: { evaluationIterations?: number }[]) {
  const getConfig = vi.fn();
  for (const v of values) {
    getConfig.mockResolvedValueOnce({ currentSprint: null, aiProvider: null, editor: null, ...v });
  }
  return { persistence: { getConfig } as unknown as PersistencePort, getConfig };
}

interface PrivateHandle {
  getEvaluationConfig: (options?: { noEvaluate?: boolean; session?: boolean }) => Promise<{
    enabled: boolean;
    iterations: number;
  }>;
}

function createUseCase(persistence: PersistencePort): PrivateHandle {
  const placeholder = {} as never;
  const instance = new ExecuteTasksUseCase(
    persistence,
    placeholder,
    placeholder,
    placeholder,
    placeholder,
    placeholder,
    placeholder,
    placeholder,
    placeholder,
    placeholder,
    placeholder
  );
  return instance as unknown as PrivateHandle;
}

describe('ExecuteTasksUseCase — live config (REQ-12)', () => {
  it('reads evaluationIterations fresh on each call (no snapshot)', async () => {
    const { persistence, getConfig } = makePersistenceWithGetConfig([
      { evaluationIterations: 2 },
      { evaluationIterations: 0 },
      { evaluationIterations: 5 },
    ]);
    const uc = createUseCase(persistence);

    const first = await uc.getEvaluationConfig();
    const second = await uc.getEvaluationConfig();
    const third = await uc.getEvaluationConfig();

    expect(getConfig).toHaveBeenCalledTimes(3);
    expect(first).toEqual({ enabled: true, iterations: 2 });
    expect(second).toEqual({ enabled: false, iterations: 0 });
    expect(third).toEqual({ enabled: true, iterations: 5 });
  });

  it('honours --no-evaluate even when iterations > 0', async () => {
    const { persistence } = makePersistenceWithGetConfig([{ evaluationIterations: 3 }]);
    const uc = createUseCase(persistence);
    const cfg = await uc.getEvaluationConfig({ noEvaluate: true });
    expect(cfg).toEqual({ enabled: false, iterations: 3 });
  });

  it('honours session mode (disables evaluation)', async () => {
    const { persistence } = makePersistenceWithGetConfig([{ evaluationIterations: 3 }]);
    const uc = createUseCase(persistence);
    const cfg = await uc.getEvaluationConfig({ session: true });
    expect(cfg).toEqual({ enabled: false, iterations: 3 });
  });

  it('defaults to 1 when evaluationIterations is unset', async () => {
    const { persistence } = makePersistenceWithGetConfig([{}]);
    const uc = createUseCase(persistence);
    const cfg = await uc.getEvaluationConfig();
    expect(cfg).toEqual({ enabled: true, iterations: 1 });
  });
});

// ---------------------------------------------------------------------------
// runFeedbackLoopOnly — synthetic-task behaviour
// ---------------------------------------------------------------------------

interface FeedbackDeps {
  uc: ExecuteTasksUseCase;
  events: HarnessEvent[];
  getFeedback: ReturnType<typeof vi.fn>;
  spawnWithRetry: ReturnType<typeof vi.fn>;
  runCheckScript: ReturnType<typeof vi.fn>;
  signalHandler: { handleProgress: ReturnType<typeof vi.fn>; handleNote: ReturnType<typeof vi.fn> };
  logProgress: ReturnType<typeof vi.fn>;
  warnings: string[];
}

function makeSprint(): Sprint {
  return {
    id: 's1',
    name: 'Sprint 1',
    projectId: 'p1',
    status: 'active',
    createdAt: new Date().toISOString(),
    activatedAt: new Date().toISOString(),
    closedAt: null,
    tickets: [],
    checkRanAt: {},
    branch: null,
  };
}

function buildFeedbackDeps(feedbackResponses: (string | null)[], spawnOutput = '<note>done</note>'): FeedbackDeps {
  const events: HarnessEvent[] = [];
  const warnings: string[] = [];

  const getFeedback = vi.fn();
  for (const r of feedbackResponses) getFeedback.mockResolvedValueOnce(r);

  const spawnWithRetry = vi.fn().mockResolvedValue({ output: spawnOutput, sessionId: 'sid' });
  const runCheckScript = vi.fn().mockReturnValue({ passed: true });

  const handleProgress = vi.fn().mockResolvedValue({ ok: true });
  const handleNote = vi.fn().mockResolvedValue({ ok: true });
  const handleTaskBlocked = vi.fn().mockResolvedValue({ ok: true });

  const logProgress = vi.fn().mockResolvedValue(undefined);

  const persistence = {
    logProgress,
    getTasks: vi.fn().mockResolvedValue([
      { id: 't1', repoId: 'r1', status: 'done', name: 'Task A' },
      { id: 't2', repoId: 'r1', status: 'done', name: 'Task B' },
    ]),
    resolveRepoPath: vi.fn().mockResolvedValue('/repo/a'),
    getRepoById: vi.fn().mockResolvedValue({
      project: { id: 'p1', name: 'p1', displayName: 'P1', repositories: [] },
      repo: { id: 'r1', name: 'a', path: '/repo/a', checkScript: 'echo ok' },
    }),
  } as unknown as PersistencePort;

  const aiSession = {
    ensureReady: vi.fn().mockResolvedValue(undefined),
    getProviderDisplayName: () => 'Claude',
    getSpawnEnv: () => ({}),
    spawnWithRetry,
  } as unknown as AiSessionPort;

  const promptBuilder = {
    buildFeedbackPrompt: () => 'feedback-prompt',
  } as unknown as PromptBuilderPort;

  const parser = {} as unknown as OutputParserPort;
  const ui = { getFeedback } as unknown as UserInteractionPort;

  const spinner = { succeed: vi.fn(), fail: vi.fn() };
  const logger = {
    info: vi.fn(),
    warning: (msg: string) => warnings.push(msg),
    success: vi.fn(),
    spinner: vi.fn(() => spinner),
    child: vi.fn(),
    time: vi.fn(() => () => undefined),
  } as unknown as LoggerPort;

  const external = { runCheckScript } as unknown as ExternalPort;
  const fs = { getSprintDir: () => '/tmp/sprint' } as unknown as FilesystemPort;

  // Parse a single <note> into a NoteSignal so dispatchSignals routes to handleNote.
  const signalParser = {
    parseSignals: (out: string) => {
      const signals: ({ type: string } & Record<string, unknown>)[] = [];
      if (out.includes('<note>')) signals.push({ type: 'note', text: 'done' });
      if (out.includes('<task-blocked>')) {
        const m = /<task-blocked>([\s\S]*?)<\/task-blocked>/.exec(out);
        signals.push({ type: 'task-blocked', reason: m?.[1] ?? 'blocked' });
      }
      return signals as never;
    },
  } as unknown as SignalParserPort;

  const signalHandler = {
    handleProgress,
    handleNote,
    handleTaskBlocked,
    handleEvaluation: vi.fn().mockResolvedValue({ ok: true }),
    handleTaskComplete: vi.fn().mockResolvedValue({ ok: true }),
    handleTaskVerified: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as SignalHandlerPort;

  const signalBus: SignalBusPort = {
    emit: (e) => events.push(e),
    subscribe: () => () => undefined,
    dispose: () => undefined,
  };

  const uc = new ExecuteTasksUseCase(
    persistence,
    aiSession,
    promptBuilder,
    parser,
    ui,
    logger,
    external,
    fs,
    signalParser,
    signalHandler,
    signalBus
  );

  return {
    uc,
    events,
    getFeedback,
    spawnWithRetry,
    runCheckScript,
    signalHandler: { handleProgress, handleNote },
    logProgress,
    warnings,
  };
}

describe('ExecuteTasksUseCase — runFeedbackLoopOnly', () => {
  it('empty feedback exits the loop without spawning', async () => {
    const deps = buildFeedbackDeps([null]);
    await deps.uc.runFeedbackLoopOnly(makeSprint());
    expect(deps.spawnWithRetry).not.toHaveBeenCalled();
    expect(deps.events).toEqual([]);
  });

  it('emits task-started and task-finished per repo for each iteration', async () => {
    const deps = buildFeedbackDeps(['improve the error message', null]);
    await deps.uc.runFeedbackLoopOnly(makeSprint());

    const started = deps.events.filter((e) => e.type === 'task-started');
    const finished = deps.events.filter((e) => e.type === 'task-finished');
    expect(started).toHaveLength(1);
    expect(finished).toHaveLength(1);
    const s = started[0];
    const f = finished[0];
    if (s?.type !== 'task-started' || f?.type !== 'task-finished') throw new Error('wrong event types');
    expect(s).toMatchObject({ sprintId: 's1' });
    expect(f).toMatchObject({ sprintId: 's1', status: 'done' });
    expect(s.taskId).toBe(f.taskId);
    expect(s.taskId).toMatch(/^feedback-/);
  });

  it('dispatches parsed signals to the signal handler', async () => {
    const deps = buildFeedbackDeps(['fix the thing', null], '<note>looks good</note>');
    await deps.uc.runFeedbackLoopOnly(makeSprint());
    expect(deps.signalHandler.handleNote).toHaveBeenCalledTimes(1);
  });

  it('runs post-task check script for each affected repo', async () => {
    const deps = buildFeedbackDeps(['tweak logging', null]);
    await deps.uc.runFeedbackLoopOnly(makeSprint());
    expect(deps.runCheckScript).toHaveBeenCalledTimes(1);
    expect(deps.runCheckScript).toHaveBeenCalledWith('/repo/a', 'echo ok', 'taskComplete', undefined);
  });

  it('emits task-finished with status=blocked when AI emits task-blocked', async () => {
    const deps = buildFeedbackDeps(['do it', null], '<task-blocked>missing creds</task-blocked>');
    await deps.uc.runFeedbackLoopOnly(makeSprint());
    const finished = deps.events.find((e) => e.type === 'task-finished');
    expect(finished).toMatchObject({ type: 'task-finished', status: 'blocked' });
    expect(deps.warnings.some((w) => w.includes('Feedback blocked'))).toBe(true);
  });

  it('emits task-finished with status=failed when spawn throws', async () => {
    const deps = buildFeedbackDeps(['do it', null]);
    deps.spawnWithRetry.mockReset();
    deps.spawnWithRetry.mockRejectedValue(new Error('boom'));
    await deps.uc.runFeedbackLoopOnly(makeSprint());
    const finished = deps.events.find((e) => e.type === 'task-finished');
    expect(finished).toMatchObject({ type: 'task-finished', status: 'failed' });
  });

  it('synthetic task name truncates feedback past 60 chars with ellipsis', async () => {
    const long = 'a'.repeat(80);
    const deps = buildFeedbackDeps([long, null]);
    await deps.uc.runFeedbackLoopOnly(makeSprint());
    const started = deps.events.find((e) => e.type === 'task-started');
    if (started?.type !== 'task-started') throw new Error('expected task-started');
    expect(started.taskName.length).toBeLessThanOrEqual('Feedback: '.length + 61);
    expect(started.taskName.endsWith('…')).toBe(true);
  });
});
