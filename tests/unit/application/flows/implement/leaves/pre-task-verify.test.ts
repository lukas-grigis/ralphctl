import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { absolutePath, FIXED_NOW, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Task } from '@src/domain/entity/task.ts';
import {
  preTaskVerifyLeaf,
  type PreTaskVerifyEnvironment,
} from '@src/application/flows/implement/leaves/pre-task-verify.ts';
import type { ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import { createSprintExecution, type SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { Choice, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

const CWD = absolutePath('/tmp/repo');

const SPRINT_ID = ((): SprintId => {
  const id = SprintId.parse('0193ed2b-1234-7abc-8def-0123456789ab');
  if (!id.ok) throw new Error('test setup');
  return id.value;
})();

const TTY_ENV: PreTaskVerifyEnvironment = { isStdinTty: true, isCi: false, isNoTui: false };
const NON_TTY_ENV: PreTaskVerifyEnvironment = { isStdinTty: false, isCi: false, isNoTui: false };
const CI_ENV: PreTaskVerifyEnvironment = { isStdinTty: true, isCi: true, isNoTui: false };

const fakeRunner = (result: { passed: boolean; exitCode: number | null; output: string }): ShellScriptRunner => ({
  async run() {
    return Result.ok({ ...result, durationMs: 0 });
  },
});

const errorRunner = (message = 'shell missing'): ShellScriptRunner => ({
  async run() {
    return Result.error({
      code: 'storage-error',
      subCode: 'io',
      name: 'StorageError',
      message,
    } as never);
  },
});

interface FakeRepo extends UpdateTask {
  readonly updates: readonly Task[];
}

const fakeTaskRepo = (): FakeRepo => {
  const updates: Task[] = [];
  return {
    updates,
    async update(_sprintId, task) {
      updates.push(task);
      return Result.ok(undefined);
    },
  };
};

interface FakeExecRepo extends Save<SprintExecution> {
  readonly saves: readonly SprintExecution[];
}

const fakeExecRepo = (): FakeExecRepo => {
  const saves: SprintExecution[] = [];
  return {
    saves,
    async save(entity: SprintExecution) {
      saves.push(entity);
      return Result.ok(undefined);
    },
  };
};

/**
 * Throwing-on-call prompt — used when the test asserts NO prompt was issued (proceeds the
 * happy path / amnesty path). Any call here is a test failure.
 */
const neverPrompt: InteractivePrompt = {
  async askText() {
    throw new Error('askText should not be called');
  },
  async askTextArea() {
    throw new Error('askTextArea should not be called');
  },
  async askChoice() {
    throw new Error('askChoice should not be called');
  },
  async askMultiChoice() {
    throw new Error('askMultiChoice should not be called');
  },
  async askConfirm() {
    throw new Error('askConfirm should not be called');
  },
};

interface PromptCounter {
  readonly prompt: InteractivePrompt;
  readonly callCount: () => number;
}

const scriptedChoicePrompt = <T>(answer: Result<T, StorageError | AbortError>): PromptCounter => {
  let calls = 0;
  const prompt: InteractivePrompt = {
    async askText() {
      throw new Error('askText should not be called');
    },
    async askTextArea() {
      throw new Error('askTextArea should not be called');
    },
    async askChoice<U>(_p: string, _opts: ReadonlyArray<Choice<U>>) {
      void _p;
      void _opts;
      calls += 1;
      return answer as unknown as Result<U, StorageError | AbortError>;
    },
    async askMultiChoice() {
      throw new Error('askMultiChoice should not be called');
    },
    async askConfirm() {
      throw new Error('askConfirm should not be called');
    },
  };
  return { prompt, callCount: () => calls };
};

interface FixtureOpts {
  readonly verifyScript?: string;
  readonly env?: PreTaskVerifyEnvironment;
  readonly interactive?: InteractivePrompt;
  readonly execution?: SprintExecution;
}

interface Fixture {
  readonly ctx: ImplementCtx;
  readonly leaf: ReturnType<typeof preTaskVerifyLeaf>;
  readonly repo: FakeRepo;
  readonly execRepo: FakeExecRepo;
}

const fixture = (runner: ShellScriptRunner, opts: FixtureOpts = {}): Fixture => {
  const task = makeInProgressTaskWithRunningAttempt();
  const execution = opts.execution ?? createSprintExecution({ sprintId: SPRINT_ID });
  const ctx: ImplementCtx = {
    sprintId: SPRINT_ID,
    currentTask: task,
    currentTaskId: task.id,
    tasks: [task],
    execution,
  };
  const repo = fakeTaskRepo();
  const execRepo = fakeExecRepo();
  const bus = createCapturingBus();
  const leaf = preTaskVerifyLeaf(
    {
      shellScriptRunner: runner,
      taskRepo: repo,
      sprintExecutionRepo: execRepo,
      interactive: opts.interactive ?? neverPrompt,
      clock: () => FIXED_NOW,
      eventBus: bus.bus,
      logger: noopLogger,
      environment: opts.env ?? TTY_ENV,
    },
    { cwd: CWD, ...(opts.verifyScript !== undefined ? { verifyScript: opts.verifyScript } : {}) },
    task.id
  );
  return { ctx, leaf, repo, execRepo };
};

describe('preTaskVerifyLeaf — happy / spawn-error paths', () => {
  it('skipped row when no verifyScript configured — no prompt, lastPreVerifyOutcome="skipped"', async () => {
    const { ctx, leaf, repo } = fixture(fakeRunner({ passed: true, exitCode: 0, output: '' }));
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(out.value.ctx.lastPreVerifyOutcome).toBe('skipped');
    const att = out.value.ctx.currentTask?.attempts.at(-1);
    expect(att?.verifyRuns?.[0]?.phase).toBe('pre');
    expect(att?.verifyRuns?.[0]?.outcome).toBe('skipped');
    expect(att?.baselineBroken).toBeUndefined();
    expect(repo.updates).toHaveLength(1);
  });

  it('records pre-row outcome="success" when script runs green', async () => {
    const { ctx, leaf, repo } = fixture(fakeRunner({ passed: true, exitCode: 0, output: 'OK' }), {
      verifyScript: 'pnpm test',
    });
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(out.value.ctx.lastPreVerifyOutcome).toBe('success');
    const att = out.value.ctx.currentTask?.attempts.at(-1);
    expect(att?.verifyRuns?.[0]?.outcome).toBe('success');
    expect(att?.baselineBroken).toBeUndefined();
    expect(repo.updates).toHaveLength(1);
  });

  it('records pre-row outcome="spawn-error" when shell could not start — no prompt, no baselineBroken', async () => {
    const { ctx, leaf, repo } = fixture(errorRunner('command not found'), {
      verifyScript: 'missing-binary',
    });
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(out.value.ctx.lastPreVerifyOutcome).toBe('spawn-error');
    const att = out.value.ctx.currentTask?.attempts.at(-1);
    expect(att?.verifyRuns?.[0]?.outcome).toBe('spawn-error');
    // spawn-error is NOT known-bad baseline — leave the flag unset so attribution is skipped
    // downstream rather than mis-attributing.
    expect(att?.baselineBroken).toBeUndefined();
    expect(repo.updates).toHaveLength(1);
  });
});

describe('preTaskVerifyLeaf — red baseline interactive gate', () => {
  it('TTY + no prior policy + operator picks "proceed" → persisted, chain continues, banner shown', async () => {
    const promptCounter = scriptedChoicePrompt(Result.ok('proceed' as const));
    const bus = createCapturingBus();
    const task = makeInProgressTaskWithRunningAttempt();
    const execution = createSprintExecution({ sprintId: SPRINT_ID });
    const ctx: ImplementCtx = {
      sprintId: SPRINT_ID,
      currentTask: task,
      currentTaskId: task.id,
      tasks: [task],
      execution,
    };
    const repo = fakeTaskRepo();
    const execRepo = fakeExecRepo();
    const leaf = preTaskVerifyLeaf(
      {
        shellScriptRunner: fakeRunner({ passed: false, exitCode: 1, output: 'broken' }),
        taskRepo: repo,
        sprintExecutionRepo: execRepo,
        interactive: promptCounter.prompt,
        clock: () => FIXED_NOW,
        eventBus: bus.bus,
        logger: noopLogger,
        environment: TTY_ENV,
      },
      { cwd: CWD, verifyScript: 'pnpm test' },
      task.id
    );
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(promptCounter.callCount()).toBe(1);
    expect(execRepo.saves).toHaveLength(1);
    expect(execRepo.saves[0]?.baselineBrokenPolicy).toBe('proceed');
    expect(out.value.ctx.execution?.baselineBrokenPolicy).toBe('proceed');
    expect(out.value.ctx.lastExit).toBeUndefined();
    expect(out.value.ctx.lastBlockReason).toBeUndefined();
    expect(out.value.ctx.lastPreVerifyOutcome).toBe('failed');
    // Warning banner emitted on proceed.
    expect(bus.events.some((e) => e.type === 'banner-show' && e.tier === 'warn')).toBe(true);
  });

  it('TTY + no prior policy + operator picks "skip" → no policy persisted, lastExit self-blocked, blockReason set', async () => {
    const promptCounter = scriptedChoicePrompt(Result.ok('skip' as const));
    const { ctx, leaf, repo, execRepo } = fixture(fakeRunner({ passed: false, exitCode: 2, output: 'fail' }), {
      verifyScript: 'pnpm test',
      env: TTY_ENV,
      interactive: promptCounter.prompt,
    });
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(promptCounter.callCount()).toBe(1);
    expect(execRepo.saves).toHaveLength(0);
    expect(out.value.ctx.execution?.baselineBrokenPolicy).toBeUndefined();
    expect(out.value.ctx.lastBlockReason).toBe('operator skipped task on broken baseline');
    expect(out.value.ctx.lastExit).toEqual({
      kind: 'self-blocked',
      reason: 'operator skipped task on broken baseline',
    });
    expect(out.value.ctx.lastPreVerifyOutcome).toBe('failed');
    // The pre-row was still persisted on the running attempt.
    expect(repo.updates).toHaveLength(1);
  });

  it('TTY + no prior policy + operator picks "abort" → leaf returns Result.error(AbortError)', async () => {
    const promptCounter = scriptedChoicePrompt(Result.ok('abort' as const));
    const { ctx, leaf, execRepo } = fixture(fakeRunner({ passed: false, exitCode: 1, output: 'fail' }), {
      verifyScript: 'pnpm test',
      env: TTY_ENV,
      interactive: promptCounter.prompt,
    });
    const out = await leaf.execute(ctx);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected error');
    expect(out.error.error).toBeInstanceOf(AbortError);
    expect((out.error.error as AbortError).reason).toBe('operator aborted sprint on broken baseline');
    expect(execRepo.saves).toHaveLength(0);
  });

  it('TTY + prior policy "proceed" → no prompt, chain continues, banner shown', async () => {
    const seed = createSprintExecution({ sprintId: SPRINT_ID });
    const execution: SprintExecution = { ...seed, baselineBrokenPolicy: 'proceed' };
    const bus = createCapturingBus();
    const task = makeInProgressTaskWithRunningAttempt();
    const ctx: ImplementCtx = {
      sprintId: SPRINT_ID,
      currentTask: task,
      currentTaskId: task.id,
      tasks: [task],
      execution,
    };
    const repo = fakeTaskRepo();
    const execRepo = fakeExecRepo();
    const leaf = preTaskVerifyLeaf(
      {
        shellScriptRunner: fakeRunner({ passed: false, exitCode: 1, output: 'still broken' }),
        taskRepo: repo,
        sprintExecutionRepo: execRepo,
        interactive: neverPrompt,
        clock: () => FIXED_NOW,
        eventBus: bus.bus,
        logger: noopLogger,
        environment: TTY_ENV,
      },
      { cwd: CWD, verifyScript: 'pnpm test' },
      task.id
    );
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(execRepo.saves).toHaveLength(0);
    expect(out.value.ctx.lastExit).toBeUndefined();
    expect(out.value.ctx.lastBlockReason).toBeUndefined();
    expect(out.value.ctx.lastPreVerifyOutcome).toBe('failed');
    expect(bus.events.some((e) => e.type === 'banner-show' && e.tier === 'warn')).toBe(true);
  });

  it('non-TTY context → hard-block, no prompt, lastExit self-blocked with non-interactive reason', async () => {
    const { ctx, leaf, execRepo } = fixture(fakeRunner({ passed: false, exitCode: 1, output: 'broken' }), {
      verifyScript: 'pnpm test',
      env: NON_TTY_ENV,
      interactive: neverPrompt,
    });
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(execRepo.saves).toHaveLength(0);
    expect(out.value.ctx.lastBlockReason).toMatch(/non-interactive/);
    expect(out.value.ctx.lastExit?.kind).toBe('self-blocked');
    expect(out.value.ctx.lastPreVerifyOutcome).toBe('failed');
  });

  it('CI=true context → hard-block even when stdin is a TTY (CI agents have no operator)', async () => {
    const { ctx, leaf, execRepo } = fixture(fakeRunner({ passed: false, exitCode: 1, output: 'broken' }), {
      verifyScript: 'pnpm test',
      env: CI_ENV,
      interactive: neverPrompt,
    });
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(execRepo.saves).toHaveLength(0);
    expect(out.value.ctx.lastBlockReason).toMatch(/non-interactive/);
    expect(out.value.ctx.lastExit?.kind).toBe('self-blocked');
  });

  it('green pre-verify with prior policy "proceed" → policy cleared back to undefined', async () => {
    const seed = createSprintExecution({ sprintId: SPRINT_ID });
    const execution: SprintExecution = { ...seed, baselineBrokenPolicy: 'proceed' };
    const { ctx, leaf, execRepo } = fixture(fakeRunner({ passed: true, exitCode: 0, output: 'OK' }), {
      verifyScript: 'pnpm test',
      execution,
    });
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(execRepo.saves).toHaveLength(1);
    expect(execRepo.saves[0]?.baselineBrokenPolicy).toBeUndefined();
    expect(out.value.ctx.execution?.baselineBrokenPolicy).toBeUndefined();
    expect(out.value.ctx.lastPreVerifyOutcome).toBe('success');
  });
});

describe('preTaskVerifyLeaf — ctx contract', () => {
  it('throws InvalidStateError when ctx.currentTask is missing', async () => {
    const { leaf } = fixture(fakeRunner({ passed: true, exitCode: 0, output: '' }));
    const out = await leaf.execute({ sprintId: SPRINT_ID });
    expect(out.ok).toBe(false);
  });

  it('throws InvalidStateError when ctx.execution is missing', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const ctx: ImplementCtx = {
      sprintId: SPRINT_ID,
      currentTask: task,
      currentTaskId: task.id,
      tasks: [task],
      // no execution
    };
    const repo = fakeTaskRepo();
    const execRepo = fakeExecRepo();
    const bus = createCapturingBus();
    const leaf = preTaskVerifyLeaf(
      {
        shellScriptRunner: fakeRunner({ passed: true, exitCode: 0, output: '' }),
        taskRepo: repo,
        sprintExecutionRepo: execRepo,
        interactive: neverPrompt,
        clock: () => FIXED_NOW,
        eventBus: bus.bus,
        logger: noopLogger,
        environment: TTY_ENV,
      },
      { cwd: CWD },
      task.id
    );
    const out = await leaf.execute(ctx);
    expect(out.ok).toBe(false);
  });
});
