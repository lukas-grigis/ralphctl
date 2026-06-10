import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import {
  absolutePath,
  FIXED_NOW,
  FIXED_REPOSITORY_ID,
  makeInProgressTaskWithRunningAttempt,
  repositoryId,
} from '@tests/fixtures/domain.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Task } from '@src/domain/entity/task.ts';
import {
  type PreTaskVerifyEnvironment,
  preTaskVerifyLeaf,
} from '@src/application/flows/implement/leaves/pre-task-verify.ts';
import type { ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
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

interface ShellRunnerCounter {
  readonly runner: ShellScriptRunner;
  readonly callCount: () => number;
}

const fakeRunner = (result: { passed: boolean; exitCode: number | null; output: string }): ShellScriptRunner => ({
  async run() {
    return Result.ok({ ...result, durationMs: 0 });
  },
});

const countingShellRunner = (result: {
  passed: boolean;
  exitCode: number | null;
  output: string;
}): ShellRunnerCounter => {
  let calls = 0;
  const runner: ShellScriptRunner = {
    async run() {
      calls += 1;
      return Result.ok({ ...result, durationMs: 0 });
    },
  };
  return { runner, callCount: () => calls };
};

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

/**
 * Stub GitRunner — answers `git status --porcelain` deterministically. Default fixture uses
 * the "clean" variant so existing tests (which don't seed `priorPostVerifyOutcome` on ctx)
 * still take the real-script path; the short-circuit branch only activates when the carry is
 * present.
 */
interface GitRunnerCounter {
  readonly runner: GitRunner;
  readonly callCount: () => number;
}

const cleanGitRunner = (): GitRunnerCounter => {
  let calls = 0;
  const runner: GitRunner = {
    async run() {
      calls += 1;
      return Result.ok({ stdout: '', stderr: '', exitCode: 0 });
    },
  };
  return { runner, callCount: () => calls };
};

const dirtyGitRunner = (): GitRunnerCounter => {
  let calls = 0;
  const runner: GitRunner = {
    async run() {
      calls += 1;
      return Result.ok({ stdout: ' M src/foo.ts\n', stderr: '', exitCode: 0 });
    },
  };
  return { runner, callCount: () => calls };
};

const errorGitRunner = (): GitRunnerCounter => {
  let calls = 0;
  const runner: GitRunner = {
    async run() {
      calls += 1;
      return Result.error({
        code: 'storage-error',
        subCode: 'io',
        name: 'StorageError',
        message: 'git not found',
      } as never);
    },
  };
  return { runner, callCount: () => calls };
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
  readonly verifyGates?: ReadonlyArray<{ pathPrefix: string; command: string; timeoutMs?: number }>;
  readonly timeoutMs?: number;
  readonly env?: PreTaskVerifyEnvironment;
  readonly interactive?: InteractivePrompt;
  readonly execution?: SprintExecution;
  readonly gitRunner?: GitRunner;
  readonly skipPreVerifyOnFreshSetup?: boolean;
  readonly setupVerifiedRepoIds?: ReadonlyArray<ReturnType<typeof repositoryId>>;
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
    ...(opts.setupVerifiedRepoIds !== undefined ? { setupVerifiedRepoIdsThisRun: opts.setupVerifiedRepoIds } : {}),
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
      gitRunner: opts.gitRunner ?? cleanGitRunner().runner,
      clock: () => FIXED_NOW,
      eventBus: bus.bus,
      logger: noopLogger,
      environment: opts.env ?? TTY_ENV,
    },
    {
      cwd: CWD,
      ...(opts.skipPreVerifyOnFreshSetup !== undefined
        ? { skipPreVerifyOnFreshSetup: opts.skipPreVerifyOnFreshSetup }
        : {}),
      ...(opts.verifyScript !== undefined ? { verifyScript: opts.verifyScript } : {}),
      ...(opts.verifyGates !== undefined ? { verifyGates: opts.verifyGates } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    },
    task.id
  );
  return { ctx, leaf, repo, execRepo };
};

// Captures the opts handed to the shell runner so we can assert the verify timeout is threaded.
const capturingShellRunner = (
  result: { passed: boolean; exitCode: number | null; output: string },
  sink: { opts: unknown }
): ShellScriptRunner => ({
  async run(_cwd, _script, runOpts) {
    sink.opts = runOpts;
    return Result.ok({ ...result, durationMs: 0 });
  },
});

describe('preTaskVerifyLeaf — verifyTimeout plumbing', () => {
  // Regression: Repository.verifyTimeout was dropped between the entity and the chain, so a
  // user-set timeout silently had no effect and a hung verify burned the full 5-min default on
  // BOTH the pre- and post-task call. The leaf must forward its `timeoutMs` opt to the runner.
  it('threads the configured verifyTimeout to the shell runner as timeoutMs', async () => {
    const sink: { opts: unknown } = { opts: undefined };
    const runner = capturingShellRunner({ passed: true, exitCode: 0, output: 'ok' }, sink);
    const { ctx, leaf } = fixture(runner, { verifyScript: 'pnpm test', timeoutMs: 90_000 });
    const res = await leaf.execute(ctx);
    expect(res.ok).toBe(true);
    expect((sink.opts as { timeoutMs?: number } | undefined)?.timeoutMs).toBe(90_000);
  });

  it('omits timeoutMs when no verifyTimeout is configured (runner falls back to its default)', async () => {
    const sink: { opts: unknown } = { opts: undefined };
    const runner = capturingShellRunner({ passed: true, exitCode: 0, output: 'ok' }, sink);
    const { ctx, leaf } = fixture(runner, { verifyScript: 'pnpm test' });
    const res = await leaf.execute(ctx);
    expect(res.ok).toBe(true);
    expect((sink.opts as { timeoutMs?: number } | undefined)?.timeoutMs).toBeUndefined();
  });
});

describe('preTaskVerifyLeaf — structured verifyGates (T11, all-run, no scope)', () => {
  // Records which gate commands ran; can be made to fail specific gates.
  const gateShell = (
    fail: ReadonlySet<string> = new Set()
  ): { runner: ShellScriptRunner; ran: () => readonly string[] } => {
    const ran: string[] = [];
    const runner: ShellScriptRunner = {
      async run(_cwd, command) {
        ran.push(command);
        const passed = !fail.has(command);
        return Result.ok({ passed, exitCode: passed ? 0 : 1, output: `${command}-out`, durationMs: 0 });
      },
    };
    return { runner, ran: () => ran };
  };

  const GATES = [
    { pathPrefix: 'apps/web-ui', command: 'test-web' },
    { pathPrefix: 'apps/api', command: 'test-api' },
    { pathPrefix: '', command: 'lint-all' },
  ] as const;

  it('runs ALL gates regardless of which paths changed (baseline needs the complete picture)', async () => {
    const { runner, ran } = gateShell();
    const { ctx, leaf } = fixture(runner, { verifyGates: GATES });
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(ran()).toEqual(['test-web', 'test-api', 'lint-all']);
    expect(out.value.ctx.lastPreVerifyOutcome).toBe('success');
  });

  it('all-run continues past an early red gate and the aggregate baseline is red (baselineBroken stamped)', async () => {
    const { runner, ran } = gateShell(new Set(['test-web']));
    // Non-interactive so a red baseline hard-blocks deterministically without a prompt.
    const { ctx, leaf } = fixture(runner, { verifyGates: GATES, env: NON_TTY_ENV });
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    // Every gate still ran (all-run) even though test-web failed first.
    expect(ran()).toEqual(['test-web', 'test-api', 'lint-all']);
    expect(out.value.ctx.lastPreVerifyOutcome).toBe('failed');
    expect(out.value.ctx.currentTask?.attempts.at(-1)?.baselineBroken).toBe(true);
  });

  it('gates win over a legacy verifyScript when both configured', async () => {
    const { runner, ran } = gateShell();
    const { ctx, leaf } = fixture(runner, { verifyScript: 'legacy-script', verifyGates: GATES });
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(ran()).toEqual(['test-web', 'test-api', 'lint-all']);
    expect(ran()).not.toContain('legacy-script');
  });
});

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
        gitRunner: cleanGitRunner().runner,
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
        gitRunner: cleanGitRunner().runner,
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
        gitRunner: cleanGitRunner().runner,
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

describe('preTaskVerifyLeaf — carry-baseline short-circuit', () => {
  it('carried success + same cwd + clean tree → short-circuits (no script, no audit row, no prompt)', async () => {
    const shell = countingShellRunner({ passed: true, exitCode: 0, output: 'OK' });
    const git = cleanGitRunner();
    const task = makeInProgressTaskWithRunningAttempt();
    const execution = createSprintExecution({ sprintId: SPRINT_ID });
    const ctx: ImplementCtx = {
      sprintId: SPRINT_ID,
      currentTask: task,
      currentTaskId: task.id,
      tasks: [task],
      execution,
      priorPostVerifyOutcome: { cwd: CWD, outcome: 'success' },
    };
    const repo = fakeTaskRepo();
    const execRepo = fakeExecRepo();
    const bus = createCapturingBus();
    const leaf = preTaskVerifyLeaf(
      {
        shellScriptRunner: shell.runner,
        taskRepo: repo,
        sprintExecutionRepo: execRepo,
        interactive: neverPrompt,
        gitRunner: git.runner,
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

    // Verify script NEVER ran.
    expect(shell.callCount()).toBe(0);
    // Git status was probed exactly once.
    expect(git.callCount()).toBe(1);
    // No audit row appended onto the running attempt.
    expect(out.value.ctx.currentTask?.attempts.at(-1)?.verifyRuns ?? []).toHaveLength(0);
    // No taskRepo.update call (nothing to persist).
    expect(repo.updates).toHaveLength(0);
    // No execution save either — baseline amnesty is untouched on the short-circuit path.
    expect(execRepo.saves).toHaveLength(0);
    // The synthetic green carries through as `lastPreVerifyOutcome = 'success'` so
    // post-task-verify's attribution sees a green pre.
    expect(out.value.ctx.lastPreVerifyOutcome).toBe('success');
    // No info banner — only the short-circuit log line.
    expect(
      bus.events.some((e) => e.type === 'log' && e.message.includes('short-circuited (carried green baseline'))
    ).toBe(true);
  });

  it('carried success + same cwd + dirty tree → falls through to real script', async () => {
    const shell = countingShellRunner({ passed: true, exitCode: 0, output: 'OK' });
    const git = dirtyGitRunner();
    const task = makeInProgressTaskWithRunningAttempt();
    const execution = createSprintExecution({ sprintId: SPRINT_ID });
    const ctx: ImplementCtx = {
      sprintId: SPRINT_ID,
      currentTask: task,
      currentTaskId: task.id,
      tasks: [task],
      execution,
      priorPostVerifyOutcome: { cwd: CWD, outcome: 'success' },
    };
    const repo = fakeTaskRepo();
    const execRepo = fakeExecRepo();
    const bus = createCapturingBus();
    const leaf = preTaskVerifyLeaf(
      {
        shellScriptRunner: shell.runner,
        taskRepo: repo,
        sprintExecutionRepo: execRepo,
        interactive: neverPrompt,
        gitRunner: git.runner,
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

    // Verify script ran, audit row appended, repo persisted.
    expect(shell.callCount()).toBe(1);
    expect(git.callCount()).toBe(1);
    expect(out.value.ctx.currentTask?.attempts.at(-1)?.verifyRuns?.[0]?.phase).toBe('pre');
    expect(out.value.ctx.currentTask?.attempts.at(-1)?.verifyRuns?.[0]?.outcome).toBe('success');
    expect(repo.updates).toHaveLength(1);
    expect(out.value.ctx.lastPreVerifyOutcome).toBe('success');
  });

  it('carried success + DIFFERENT cwd → falls through (no git probe, real script)', async () => {
    const shell = countingShellRunner({ passed: true, exitCode: 0, output: 'OK' });
    const git = cleanGitRunner();
    const task = makeInProgressTaskWithRunningAttempt();
    const execution = createSprintExecution({ sprintId: SPRINT_ID });
    const otherCwd = absolutePath('/tmp/other-repo');
    const ctx: ImplementCtx = {
      sprintId: SPRINT_ID,
      currentTask: task,
      currentTaskId: task.id,
      tasks: [task],
      execution,
      priorPostVerifyOutcome: { cwd: otherCwd, outcome: 'success' },
    };
    const repo = fakeTaskRepo();
    const execRepo = fakeExecRepo();
    const bus = createCapturingBus();
    const leaf = preTaskVerifyLeaf(
      {
        shellScriptRunner: shell.runner,
        taskRepo: repo,
        sprintExecutionRepo: execRepo,
        interactive: neverPrompt,
        gitRunner: git.runner,
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

    // No short-circuit attempted — cwd mismatch is checked before the git probe.
    expect(git.callCount()).toBe(0);
    // Real script ran.
    expect(shell.callCount()).toBe(1);
    expect(repo.updates).toHaveLength(1);
    expect(out.value.ctx.lastPreVerifyOutcome).toBe('success');
  });

  it('carried failed outcome → falls through to real script (no short-circuit, reaches red-baseline prompt)', async () => {
    const shell = countingShellRunner({ passed: false, exitCode: 1, output: 'still broken' });
    const git = cleanGitRunner();
    const promptCounter = scriptedChoicePrompt(Result.ok('skip' as const));
    const task = makeInProgressTaskWithRunningAttempt();
    const execution = createSprintExecution({ sprintId: SPRINT_ID });
    const ctx: ImplementCtx = {
      sprintId: SPRINT_ID,
      currentTask: task,
      currentTaskId: task.id,
      tasks: [task],
      execution,
      priorPostVerifyOutcome: { cwd: CWD, outcome: 'failed' },
    };
    const repo = fakeTaskRepo();
    const execRepo = fakeExecRepo();
    const bus = createCapturingBus();
    const leaf = preTaskVerifyLeaf(
      {
        shellScriptRunner: shell.runner,
        taskRepo: repo,
        sprintExecutionRepo: execRepo,
        interactive: promptCounter.prompt,
        gitRunner: git.runner,
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

    // No short-circuit attempted because the carried outcome is not 'success'.
    expect(git.callCount()).toBe(0);
    // Real script ran AND the red-baseline prompt fired.
    expect(shell.callCount()).toBe(1);
    expect(promptCounter.callCount()).toBe(1);
    expect(out.value.ctx.lastPreVerifyOutcome).toBe('failed');
    expect(out.value.ctx.lastBlockReason).toBe('operator skipped task on broken baseline');
  });

  // D4: the 'skipped' carry must NOT short-circuit pre-verify — the shortcut requires 'success'.
  // When post-task-verify emits 'skipped' (zero-turn short-circuit case), the NEXT task's
  // pre-verify must run the real script, not assume a green baseline.
  it("carried 'skipped' outcome (prior post-verify was zero-turn) → does NOT short-circuit, runs real script", async () => {
    // Arrange: previous task's post-verify short-circuited → 'skipped' carry.
    // The pre-verify of THIS task must fall through to the real script — 'skipped' is NOT a
    // green baseline evidence. A mutant that changed the guard to `!== undefined` instead of
    // `=== 'success'` would incorrectly short-circuit on any non-undefined carry.
    const shell = countingShellRunner({ passed: true, exitCode: 0, output: 'OK' });
    const git = cleanGitRunner();
    const task = makeInProgressTaskWithRunningAttempt();
    const execution = createSprintExecution({ sprintId: SPRINT_ID });
    const ctx: ImplementCtx = {
      sprintId: SPRINT_ID,
      currentTask: task,
      currentTaskId: task.id,
      tasks: [task],
      execution,
      // Outcome is 'skipped' — NOT 'success'. The short-circuit must not fire.
      priorPostVerifyOutcome: { cwd: CWD, outcome: 'skipped' },
    };
    const repo = fakeTaskRepo();
    const execRepo = fakeExecRepo();
    const bus = createCapturingBus();
    const leaf = preTaskVerifyLeaf(
      {
        shellScriptRunner: shell.runner,
        taskRepo: repo,
        sprintExecutionRepo: execRepo,
        interactive: neverPrompt,
        gitRunner: git.runner,
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
    // Git probe must NOT have run — the cwd-match check happens BEFORE the git probe,
    // but the outcome check must fail before reaching cwd-match.
    expect(git.callCount()).toBe(0);
    // Real script must have run.
    expect(shell.callCount()).toBe(1);
    // The audit row was appended (real script ran, not synthesized).
    expect(repo.updates).toHaveLength(1);
    expect(out.value.ctx.lastPreVerifyOutcome).toBe('success');
    // Short-circuit log must NOT be present.
    expect(bus.logs.some((e) => e.message.includes('short-circuited'))).toBe(false);
  });

  it('no carried outcome (task 1 of sprint) → falls through, no git probe, real script', async () => {
    const shell = countingShellRunner({ passed: true, exitCode: 0, output: 'OK' });
    const git = cleanGitRunner();
    const task = makeInProgressTaskWithRunningAttempt();
    const execution = createSprintExecution({ sprintId: SPRINT_ID });
    const ctx: ImplementCtx = {
      sprintId: SPRINT_ID,
      currentTask: task,
      currentTaskId: task.id,
      tasks: [task],
      execution,
      // priorPostVerifyOutcome intentionally undefined — task 1 case.
    };
    const repo = fakeTaskRepo();
    const execRepo = fakeExecRepo();
    const bus = createCapturingBus();
    const leaf = preTaskVerifyLeaf(
      {
        shellScriptRunner: shell.runner,
        taskRepo: repo,
        sprintExecutionRepo: execRepo,
        interactive: neverPrompt,
        gitRunner: git.runner,
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

    // No git probe when there's nothing carried.
    expect(git.callCount()).toBe(0);
    expect(shell.callCount()).toBe(1);
    expect(repo.updates).toHaveLength(1);
    expect(out.value.ctx.lastPreVerifyOutcome).toBe('success');
  });

  it('carried success + git probe errors → demotes to ineligible, real script runs (error not surfaced)', async () => {
    const shell = countingShellRunner({ passed: true, exitCode: 0, output: 'OK' });
    const git = errorGitRunner();
    const task = makeInProgressTaskWithRunningAttempt();
    const execution = createSprintExecution({ sprintId: SPRINT_ID });
    const ctx: ImplementCtx = {
      sprintId: SPRINT_ID,
      currentTask: task,
      currentTaskId: task.id,
      tasks: [task],
      execution,
      priorPostVerifyOutcome: { cwd: CWD, outcome: 'success' },
    };
    const repo = fakeTaskRepo();
    const execRepo = fakeExecRepo();
    const bus = createCapturingBus();
    const leaf = preTaskVerifyLeaf(
      {
        shellScriptRunner: shell.runner,
        taskRepo: repo,
        sprintExecutionRepo: execRepo,
        interactive: neverPrompt,
        gitRunner: git.runner,
        clock: () => FIXED_NOW,
        eventBus: bus.bus,
        logger: noopLogger,
        environment: TTY_ENV,
      },
      { cwd: CWD, verifyScript: 'pnpm test' },
      task.id
    );

    const out = await leaf.execute(ctx);
    // Leaf returns ok — the git error is NOT propagated; the operator just gets the real
    // verify run instead of a regression.
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(git.callCount()).toBe(1);
    expect(shell.callCount()).toBe(1);
    expect(out.value.ctx.lastPreVerifyOutcome).toBe('success');
  });
});

describe('preTaskVerifyLeaf — fresh-setup short-circuit (T13)', () => {
  // Builds a standalone leaf wired with counting shell + git runners so each test can assert the
  // verify gate was (or was not) re-run and the git-clean probe fired exactly once.
  const buildLeaf = (args: {
    readonly shell: ShellRunnerCounter;
    readonly git: GitRunnerCounter;
    readonly task: Task;
    readonly skipPreVerifyOnFreshSetup?: boolean;
    readonly verifyScript?: string;
    readonly verifyGates?: ReadonlyArray<{ pathPrefix: string; command: string }>;
    readonly env?: PreTaskVerifyEnvironment;
  }): ReturnType<typeof preTaskVerifyLeaf> =>
    preTaskVerifyLeaf(
      {
        shellScriptRunner: args.shell.runner,
        taskRepo: fakeTaskRepo(),
        sprintExecutionRepo: fakeExecRepo(),
        interactive: neverPrompt,
        gitRunner: args.git.runner,
        clock: () => FIXED_NOW,
        eventBus: createCapturingBus().bus,
        logger: noopLogger,
        environment: args.env ?? TTY_ENV,
      },
      {
        cwd: CWD,
        ...(args.skipPreVerifyOnFreshSetup !== undefined
          ? { skipPreVerifyOnFreshSetup: args.skipPreVerifyOnFreshSetup }
          : {}),
        ...(args.verifyScript !== undefined ? { verifyScript: args.verifyScript } : {}),
        ...(args.verifyGates !== undefined ? { verifyGates: args.verifyGates } : {}),
      },
      args.task.id
    );

  const ctxFor = (task: Task, setupVerifiedRepoIds?: ReadonlyArray<ReturnType<typeof repositoryId>>): ImplementCtx => ({
    sprintId: SPRINT_ID,
    currentTask: task,
    currentTaskId: task.id,
    tasks: [task],
    execution: createSprintExecution({ sprintId: SPRINT_ID }),
    // priorPostVerifyOutcome intentionally absent — fresh-setup applies to the FIRST task of the run.
    ...(setupVerifiedRepoIds !== undefined ? { setupVerifiedRepoIdsThisRun: setupVerifiedRepoIds } : {}),
  });

  // (a) flag on + setup green this run + clean tree → synthetic green run, script NOT invoked.
  it('flag on + this-run setup green for the repo + clean tree → synthesizes green, verify gate NOT run', async () => {
    const shell = countingShellRunner({ passed: true, exitCode: 0, output: 'OK' });
    const git = cleanGitRunner();
    const task = makeInProgressTaskWithRunningAttempt();
    const leaf = buildLeaf({
      shell,
      git,
      task,
      skipPreVerifyOnFreshSetup: true,
      verifyScript: 'pnpm test',
    });
    const out = await leaf.execute(ctxFor(task, [FIXED_REPOSITORY_ID]));
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    // Verify gate never ran; git-clean probe fired once.
    expect(shell.callCount()).toBe(0);
    expect(git.callCount()).toBe(1);
    // No audit row appended (synthetic), green carries to attribution.
    expect(out.value.ctx.currentTask?.attempts.at(-1)?.verifyRuns ?? []).toHaveLength(0);
    expect(out.value.ctx.lastPreVerifyOutcome).toBe('success');
  });

  // (b) flag on + dirty tree → real run.
  it('flag on + dirty tree → falls through to the real verify gate', async () => {
    const shell = countingShellRunner({ passed: true, exitCode: 0, output: 'OK' });
    const git = dirtyGitRunner();
    const task = makeInProgressTaskWithRunningAttempt();
    const leaf = buildLeaf({
      shell,
      git,
      task,
      skipPreVerifyOnFreshSetup: true,
      verifyScript: 'pnpm test',
    });
    const out = await leaf.execute(ctxFor(task, [FIXED_REPOSITORY_ID]));
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(git.callCount()).toBe(1);
    expect(shell.callCount()).toBe(1);
    expect(out.value.ctx.lastPreVerifyOutcome).toBe('success');
  });

  // (c) flag on + setup from a PREVIOUS launch only (repo id NOT in this-run marker) → real run.
  it('flag on + this-run setup marker does NOT list the repo (prior-launch success only) → real run, no git probe', async () => {
    const shell = countingShellRunner({ passed: true, exitCode: 0, output: 'OK' });
    const git = cleanGitRunner();
    const task = makeInProgressTaskWithRunningAttempt();
    // Marker lists a DIFFERENT repo — this task's repo was not verified by THIS launch's setup.
    const otherRepo = repositoryId('01900000-0000-7000-8000-0000000000ff');
    const leaf = buildLeaf({
      shell,
      git,
      task,
      skipPreVerifyOnFreshSetup: true,
      verifyScript: 'pnpm test',
    });
    const out = await leaf.execute(ctxFor(task, [otherRepo]));
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    // No git probe — repo-id mismatch is checked before the git-clean call.
    expect(git.callCount()).toBe(0);
    expect(shell.callCount()).toBe(1);
    expect(out.value.ctx.lastPreVerifyOutcome).toBe('success');
  });

  it('flag on + NO this-run setup marker at all → real run, no git probe', async () => {
    const shell = countingShellRunner({ passed: true, exitCode: 0, output: 'OK' });
    const git = cleanGitRunner();
    const task = makeInProgressTaskWithRunningAttempt();
    const leaf = buildLeaf({
      shell,
      git,
      task,
      // marker undefined — no setup verified this run
      skipPreVerifyOnFreshSetup: true,
      verifyScript: 'pnpm test',
    });
    const out = await leaf.execute(ctxFor(task));
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(git.callCount()).toBe(0);
    expect(shell.callCount()).toBe(1);
    expect(out.value.ctx.lastPreVerifyOutcome).toBe('success');
  });

  // (d) flag off → real run (today's behaviour), even with a green this-run setup marker + clean tree.
  it('flag OFF + setup green this run + clean tree → real run (no skip — today behaviour preserved)', async () => {
    const shell = countingShellRunner({ passed: true, exitCode: 0, output: 'OK' });
    const git = cleanGitRunner();
    const task = makeInProgressTaskWithRunningAttempt();
    const leaf = buildLeaf({
      shell,
      git,
      task,
      skipPreVerifyOnFreshSetup: false,
      verifyScript: 'pnpm test',
    });
    const out = await leaf.execute(ctxFor(task, [FIXED_REPOSITORY_ID]));
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    // No git probe (flag-off check happens first), real script ran.
    expect(git.callCount()).toBe(0);
    expect(shell.callCount()).toBe(1);
    expect(out.value.ctx.lastPreVerifyOutcome).toBe('success');
  });

  it('flag opt absent (default off) → real run', async () => {
    const shell = countingShellRunner({ passed: true, exitCode: 0, output: 'OK' });
    const git = cleanGitRunner();
    const task = makeInProgressTaskWithRunningAttempt();
    const leaf = buildLeaf({
      shell,
      git,
      task,
      // skipPreVerifyOnFreshSetup omitted entirely
      verifyScript: 'pnpm test',
    });
    const out = await leaf.execute(ctxFor(task, [FIXED_REPOSITORY_ID]));
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(git.callCount()).toBe(0);
    expect(shell.callCount()).toBe(1);
  });

  // (e) flag on + setup green + STRUCTURED gates configured → skip applies identically.
  it('flag on + structured verifyGates configured + clean tree → synthesizes green, NO gate runs', async () => {
    const ran: string[] = [];
    let calls = 0;
    const shell: ShellRunnerCounter = {
      runner: {
        async run(_cwd, command) {
          calls += 1;
          ran.push(command);
          return Result.ok({ passed: true, exitCode: 0, output: `${command}-out`, durationMs: 0 });
        },
      },
      callCount: () => calls,
    };
    const git = cleanGitRunner();
    const task = makeInProgressTaskWithRunningAttempt();
    const leaf = buildLeaf({
      shell,
      git,
      task,
      skipPreVerifyOnFreshSetup: true,
      verifyGates: [
        { pathPrefix: 'apps/web', command: 'test-web' },
        { pathPrefix: '', command: 'lint-all' },
      ],
    });
    const out = await leaf.execute(ctxFor(task, [FIXED_REPOSITORY_ID]));
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    // No gate command ran — the skip fires before the multi-gate executor.
    expect(shell.callCount()).toBe(0);
    expect(ran).toEqual([]);
    expect(git.callCount()).toBe(1);
    expect(out.value.ctx.lastPreVerifyOutcome).toBe('success');
  });

  it('flag on + setup green + clean tree BUT a prior-task carry is present → carry path owns it (still skips, single git probe)', async () => {
    // When BOTH a carry AND a fresh-setup marker could apply, the carry-baseline short-circuit
    // wins (it is checked first) and the fresh-setup branch is gated off by `!carriedGreenForThisCwd`,
    // so the git-clean tree is probed exactly once, not twice.
    const shell = countingShellRunner({ passed: true, exitCode: 0, output: 'OK' });
    const git = cleanGitRunner();
    const task = makeInProgressTaskWithRunningAttempt();
    const ctx: ImplementCtx = {
      ...ctxFor(task, [FIXED_REPOSITORY_ID]),
      priorPostVerifyOutcome: { cwd: CWD, outcome: 'success' },
    };
    const leaf = buildLeaf({
      shell,
      git,
      task,
      skipPreVerifyOnFreshSetup: true,
      verifyScript: 'pnpm test',
    });
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(shell.callCount()).toBe(0);
    // Exactly ONE git probe — the carry path short-circuited; the fresh-setup branch did not re-probe.
    expect(git.callCount()).toBe(1);
    expect(out.value.ctx.lastPreVerifyOutcome).toBe('success');
  });
});
