import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { absolutePath, FIXED_NOW, makeInProgressTaskWithRunningAttempt, makeTodoTask } from '@tests/fixtures/domain.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { InProgressTask, Task } from '@src/domain/entity/task.ts';
import type { VerifyRunOutcome } from '@src/domain/entity/attempt.ts';
import { startNextAttempt } from '@src/domain/entity/task-attempts.ts';
import { failCurrentAttempt } from '@src/domain/entity/task-settle.ts';
import { postTaskVerifyLeaf } from '@src/application/flows/implement/leaves/post-task-verify.ts';
import type { ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';

const unwrap = <T, E>(r: Result<T, E>): T => {
  if (!r.ok) {
    const err: unknown = r.error;
    throw new Error(`test unwrap failed: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
  }
  return r.value as T;
};

/**
 * Build an in-progress task whose attempt history has `attemptN - 1` settled (`failed`) attempts
 * plus one `running` attempt — so `attempts.length === attemptN`. Drives the budget-boundary
 * cases: with `maxAttempts === 3` and `attemptN === 3` (the running attempt being the 3rd), the
 * red-post-verify retry budget is exhausted (`3 < 3` is false → no retry).
 */
const makeTaskOnAttempt = (attemptN: number, maxAttempts: number): InProgressTask => {
  let task: Task = makeTodoTask({ maxAttempts });
  for (let i = 0; i < attemptN - 1; i++) {
    task = unwrap(startNextAttempt(task, FIXED_NOW, `session-${String(i)}`));
    task = unwrap(failCurrentAttempt(task, FIXED_NOW, 'failed'));
  }
  return unwrap(startNextAttempt(task, FIXED_NOW, `session-${String(attemptN)}`));
};

const CWD = absolutePath('/tmp/repo');

const SPRINT_ID = ((): SprintId => {
  const id = SprintId.parse('0193ed2b-1234-7abc-8def-0123456789ab');
  if (!id.ok) throw new Error('test setup');
  return id.value;
})();

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

/**
 * Git runner that answers every probe with a clean exit + a deterministic single-file diff
 * footprint (`src/foo.ts`). The legacy single-script path never calls it (footprint scoping is
 * gated on structured gates being configured), so these tests' default fixtures are unaffected;
 * the structured-gate tests below supply their own footprints.
 */
const fakeGitRunner = (stdout = 'src/foo.ts\n'): GitRunner => ({
  async run() {
    return Result.ok({ stdout, stderr: '', exitCode: 0 });
  },
});

interface FakeRepo extends UpdateTask {
  readonly updates: readonly Task[];
}

const fakeTaskRepo = (): { repo: FakeRepo; mutator: (next: Task) => void } => {
  const updates: Task[] = [];
  const repo: FakeRepo = {
    updates,
    async update(_sprintId, task) {
      updates.push(task);
      return Result.ok(undefined);
    },
  };
  return { repo, mutator: () => undefined };
};

interface Fixture {
  readonly ctx: ImplementCtx;
  readonly leaf: ReturnType<typeof postTaskVerifyLeaf>;
}

const fixture = (
  runner: ShellScriptRunner,
  opts: { preOutcome?: VerifyRunOutcome; verifyScript?: string } = {}
): Fixture => {
  const task = makeInProgressTaskWithRunningAttempt();
  const ctx: ImplementCtx = {
    sprintId: SPRINT_ID,
    currentTask: task,
    currentTaskId: task.id,
    tasks: [task],
    ...(opts.preOutcome !== undefined ? { lastPreVerifyOutcome: opts.preOutcome } : {}),
  };
  const { repo } = fakeTaskRepo();
  const bus = createCapturingBus();
  const leaf = postTaskVerifyLeaf(
    {
      shellScriptRunner: runner,
      taskRepo: repo,
      gitRunner: fakeGitRunner(),
      clock: () => FIXED_NOW,
      eventBus: bus.bus,
      logger: noopLogger,
    },
    { cwd: CWD, ...(opts.verifyScript !== undefined ? { verifyScript: opts.verifyScript } : {}) },
    task.id
  );
  return { ctx, leaf };
};

describe('postTaskVerifyLeaf', () => {
  it('skips when no verifyScript configured — `lastVerifyResult` is "skipped", no attribution', async () => {
    const { ctx, leaf } = fixture(fakeRunner({ passed: true, exitCode: 0, output: '' }), { preOutcome: 'success' });
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(out.value.ctx.lastVerifyResult?.kind).toBe('skipped');
    expect(out.value.ctx.currentTask?.attempts.at(-1)?.attribution).toBeUndefined();
  });

  it('marks passed when script runs green and persists a VerifyRun row', async () => {
    const { ctx, leaf } = fixture(fakeRunner({ passed: true, exitCode: 0, output: 'OK' }), {
      preOutcome: 'success',
      verifyScript: 'pnpm test',
    });
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(out.value.ctx.lastVerifyResult?.kind).toBe('passed');
    const row = out.value.ctx.currentTask?.attempts.at(-1)?.verifyRuns?.[0];
    expect(row?.phase).toBe('post');
    expect(row?.outcome).toBe('success');
    expect(row?.exitCode).toBe(0);
    // Carry-baseline: a green post stamps `priorPostVerifyOutcome` onto ctx so the next
    // task's pre-task-verify can short-circuit when the cwd matches + tree is clean.
    expect(out.value.ctx.priorPostVerifyOutcome).toEqual({ cwd: CWD, outcome: 'success' });
  });

  it('marks verify-failed with exitCode + verbatim stderr when red (audit-[03] — no persistence-time clip)', async () => {
    // Audit-[03]: the full spawn output rounds-trip onto ctx.lastVerifyResult.stderr.
    // Truncation, when needed, happens at the display boundary (e.g. sprint-detail-view
    // takes the first non-blank line + a 120-char display clip with a `…` marker).
    const longOutput = `${'x'.repeat(5000)}\nFINAL_LINE`;
    const { ctx, leaf } = fixture(fakeRunner({ passed: false, exitCode: 1, output: longOutput }), {
      preOutcome: 'success',
      verifyScript: 'pnpm test',
    });
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    const v = out.value.ctx.lastVerifyResult;
    expect(v?.kind).toBe('verify-failed');
    if (v?.kind === 'verify-failed') {
      expect(v.exitCode).toBe(1);
      // Full body, no synthetic `truncated` marker — verbatim round-trip.
      expect(v.stderr).toBe(longOutput);
    }
  });

  it('attribution truth table — pre=green, post=green → clean (no block)', async () => {
    const { ctx, leaf } = fixture(fakeRunner({ passed: true, exitCode: 0, output: '' }), {
      preOutcome: 'success',
      verifyScript: 'pnpm test',
    });
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(out.value.ctx.currentTask?.attempts.at(-1)?.attribution).toBe('clean');
    expect(out.value.ctx.lastBlockReason).toBeUndefined();
  });

  it('attribution truth table — pre=green, post=red → regressed (block)', async () => {
    const { ctx, leaf } = fixture(fakeRunner({ passed: false, exitCode: 7, output: 'broke it' }), {
      preOutcome: 'success',
      verifyScript: 'pnpm test',
    });
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(out.value.ctx.currentTask?.attempts.at(-1)?.attribution).toBe('regressed');
    expect(out.value.ctx.lastBlockReason).toContain('regressed baseline');
    expect(out.value.ctx.lastBlockReason).toContain('exit=7');
    // Carry-baseline still records the (cwd, outcome) pair — pre-task-verify only
    // short-circuits when the outcome is 'success', so a 'failed' carry just means the next
    // task's pre-verify will fall through to the real script.
    expect(out.value.ctx.priorPostVerifyOutcome).toEqual({ cwd: CWD, outcome: 'failed' });
  });

  it('attribution truth table — pre=red, post=red → baseline-broken (preserve verdict, NO block)', async () => {
    const { ctx, leaf } = fixture(fakeRunner({ passed: false, exitCode: 1, output: 'still red' }), {
      preOutcome: 'failed',
      verifyScript: 'pnpm test',
    });
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(out.value.ctx.currentTask?.attempts.at(-1)?.attribution).toBe('baseline-broken');
    // Critically: a baseline-broken outcome must NOT block — the AI's verdict is preserved
    // so the operator can fix the baseline without losing the AI's work.
    expect(out.value.ctx.lastBlockReason).toBeUndefined();
  });

  it('attribution truth table — pre=red, post=green → fixed-baseline (no block, credit)', async () => {
    const { ctx, leaf } = fixture(fakeRunner({ passed: true, exitCode: 0, output: 'fixed' }), {
      preOutcome: 'failed',
      verifyScript: 'pnpm test',
    });
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(out.value.ctx.currentTask?.attempts.at(-1)?.attribution).toBe('fixed-baseline');
    expect(out.value.ctx.lastBlockReason).toBeUndefined();
  });

  it('spawn-error pre-verify → attribution skipped, post row still recorded as spawn-error', async () => {
    const { ctx, leaf } = fixture(errorRunner('binary missing'), {
      preOutcome: 'spawn-error',
      verifyScript: 'pnpm test',
    });
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(out.value.ctx.currentTask?.attempts.at(-1)?.attribution).toBeUndefined();
    const row = out.value.ctx.currentTask?.attempts.at(-1)?.verifyRuns?.[0];
    expect(row?.outcome).toBe('spawn-error');
  });

  describe('zero-turn short-circuit (pre-verify hard block before any gen-eval turn)', () => {
    // Counting runner — proves the verify script is NOT spawned on the short-circuit path.
    const countingRunner = (): { runner: ShellScriptRunner; calls: () => number } => {
      let calls = 0;
      return {
        runner: {
          async run() {
            calls += 1;
            return Result.ok({ passed: true, exitCode: 0, output: '', durationMs: 0 });
          },
        },
        calls: () => calls,
      };
    };

    const blockedCtx = (over: Partial<ImplementCtx> = {}): ImplementCtx => {
      const task = makeInProgressTaskWithRunningAttempt();
      return {
        sprintId: SPRINT_ID,
        currentTask: task,
        currentTaskId: task.id,
        tasks: [task],
        lastBlockReason: 'baseline already red at task start (non-interactive — operator could not be prompted)',
        ...over,
      };
    };

    const buildLeaf = (runner: ShellScriptRunner, repo: UpdateTask, taskId: Task['id']) =>
      postTaskVerifyLeaf(
        {
          shellScriptRunner: runner,
          taskRepo: repo,
          gitRunner: fakeGitRunner(),
          clock: () => FIXED_NOW,
          eventBus: createCapturingBus().bus,
          logger: noopLogger,
        },
        { cwd: CWD, verifyScript: 'pnpm test' },
        taskId
      );

    it('zero turns (lastBlockReason set, genEvalTurn undefined) → short-circuits to skipped, never spawns the script', async () => {
      const ctx = blockedCtx({ genEvalTurn: undefined });
      const { runner, calls } = countingRunner();
      const { repo } = fakeTaskRepo();
      const leaf = buildLeaf(runner, repo, ctx.currentTask!.id);
      const out = await leaf.execute(ctx);
      if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
      // No verify-script spawn, no audit-row persistence — pure short-circuit.
      expect(calls()).toBe(0);
      expect(repo.updates).toHaveLength(0);
      // Synthetic skipped run flows through legacyVerifyResult → { kind: 'skipped' }.
      expect(out.value.ctx.lastVerifyResult?.kind).toBe('skipped');
      // Attribution needs both outcomes — none here.
      expect(out.value.ctx.currentTask?.attempts.at(-1)?.attribution).toBeUndefined();
      // Pre-verify block reason survives untouched (the leaf must not clear it).
      expect(out.value.ctx.lastBlockReason).toBe(ctx.lastBlockReason);
      // Carry records outcome 'skipped' so the NEXT task's pre-verify carry (needs 'success')
      // does not short-circuit the real script.
      expect(out.value.ctx.priorPostVerifyOutcome).toEqual({ cwd: CWD, outcome: 'skipped' });
    });

    it('turn-1 generator self-block (lastBlockReason set, genEvalTurn === 1) → does NOT short-circuit, runs the real script', async () => {
      const ctx = blockedCtx({ genEvalTurn: 1, lastBlockReason: 'agent self-blocked: needs a design decision' });
      const { runner, calls } = countingRunner();
      const { repo } = fakeTaskRepo();
      const leaf = buildLeaf(runner, repo, ctx.currentTask!.id);
      const out = await leaf.execute(ctx);
      if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
      // A real turn ran — the verify script must spawn (and the audit row must persist).
      expect(calls()).toBe(1);
      expect(repo.updates).toHaveLength(1);
      // Green script → passed, not the synthetic skipped.
      expect(out.value.ctx.lastVerifyResult?.kind).toBe('passed');
    });
  });

  // ───────── T11: structured verify gates — diff-scoped fail-fast + footprint fallback ─────────
  describe('structured verifyGates (T11)', () => {
    // Records the (command) of every gate the shell ran, keyed result per command.
    const gateShell = (
      fail: ReadonlySet<string> = new Set()
    ): { runner: ShellScriptRunner; ran: () => readonly string[] } => {
      const ran: string[] = [];
      const runner: ShellScriptRunner = {
        async run(_cwd, command) {
          ran.push(command);
          const passed = !fail.has(command);
          return Result.ok({ passed, exitCode: passed ? 0 : 1, output: `${command}-out`, durationMs: 1 });
        },
      };
      return { runner, ran: () => ran };
    };

    // Git runner that returns a fixed footprint (joined newline-separated) for diff/ls-files, or
    // can be made to error / return empty to drive the fallback.
    const footprintGit = (footprint: readonly string[]): GitRunner => ({
      async run() {
        return Result.ok({ stdout: footprint.join('\n'), stderr: '', exitCode: 0 });
      },
    });
    const errorGit = (): GitRunner => ({
      async run() {
        return Result.error({
          code: 'storage-error',
          subCode: 'io',
          name: 'StorageError',
          message: 'not a git repo',
        } as never);
      },
    });

    const GATES = [
      { pathPrefix: 'apps/web-ui', command: 'test-web' },
      { pathPrefix: 'apps/api', command: 'test-api' },
      { pathPrefix: '', command: 'lint-all' },
    ] as const;

    const runGated = async (args: {
      gitRunner: GitRunner;
      shell: ShellScriptRunner;
      preOutcome?: VerifyRunOutcome;
    }) => {
      const task = makeInProgressTaskWithRunningAttempt();
      const ctx: ImplementCtx = {
        sprintId: SPRINT_ID,
        currentTask: task,
        currentTaskId: task.id,
        tasks: [task],
        ...(args.preOutcome !== undefined ? { lastPreVerifyOutcome: args.preOutcome } : {}),
      };
      const { repo } = fakeTaskRepo();
      const leaf = postTaskVerifyLeaf(
        {
          shellScriptRunner: args.shell,
          taskRepo: repo,
          gitRunner: args.gitRunner,
          clock: () => FIXED_NOW,
          eventBus: createCapturingBus().bus,
          logger: noopLogger,
        },
        { cwd: CWD, verifyGates: GATES },
        task.id
      );
      const out = await leaf.execute(ctx);
      if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
      return out.value.ctx;
    };

    it('scopes gates to the diff footprint — only the matching module gate + catch-all run', async () => {
      const { runner, ran } = gateShell();
      await runGated({ gitRunner: footprintGit(['apps/web-ui/src/App.tsx']), shell: runner, preOutcome: 'success' });
      // web-ui prefix matches + catch-all; api gate filtered out.
      expect(ran()).toEqual(['test-web', 'lint-all']);
    });

    it('a scoped red gate on a green pre is still `regressed` (like-vs-like)', async () => {
      const { runner } = gateShell(new Set(['test-web']));
      const ctx = await runGated({
        gitRunner: footprintGit(['apps/web-ui/src/App.tsx']),
        shell: runner,
        preOutcome: 'success',
      });
      expect(ctx.currentTask?.attempts.at(-1)?.attribution).toBe('regressed');
      expect(ctx.lastBlockReason).toContain('regressed baseline');
    });

    it('fallback: footprint probe error → runs ALL gates (never silently skips)', async () => {
      const { runner, ran } = gateShell();
      await runGated({ gitRunner: errorGit(), shell: runner, preOutcome: 'success' });
      expect(ran()).toEqual(['test-web', 'test-api', 'lint-all']);
    });

    it('fallback: empty footprint → runs ALL gates', async () => {
      const { runner, ran } = gateShell();
      await runGated({ gitRunner: footprintGit([]), shell: runner, preOutcome: 'success' });
      expect(ran()).toEqual(['test-web', 'test-api', 'lint-all']);
    });

    it('post fail-fast: a red module gate stops before the catch-all runs', async () => {
      const { runner, ran } = gateShell(new Set(['test-web']));
      await runGated({ gitRunner: footprintGit(['apps/web-ui/src/App.tsx']), shell: runner, preOutcome: 'success' });
      // test-web fails → fail-fast; lint-all never runs.
      expect(ran()).toEqual(['test-web']);
    });
  });

  it('persists the running attempt with the appended VerifyRun via taskRepo.update', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const ctx: ImplementCtx = {
      sprintId: SPRINT_ID,
      currentTask: task,
      currentTaskId: task.id,
      tasks: [task],
      lastPreVerifyOutcome: 'success',
    };
    const { repo } = fakeTaskRepo();
    const bus = createCapturingBus();
    const leaf = postTaskVerifyLeaf(
      {
        shellScriptRunner: fakeRunner({ passed: true, exitCode: 0, output: 'ok' }),
        taskRepo: repo,
        gitRunner: fakeGitRunner(),
        clock: () => FIXED_NOW,
        eventBus: bus.bus,
        logger: noopLogger,
      },
      { cwd: CWD, verifyScript: 'pnpm test' },
      task.id
    );
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(repo.updates).toHaveLength(1);
    const persistedRows = repo.updates[0]?.attempts.at(-1)?.verifyRuns;
    expect(persistedRows).toHaveLength(1);
    expect(persistedRows?.[0]?.phase).toBe('post');
    expect(persistedRows?.[0]?.outcome).toBe('success');
  });

  // ─── T6: bounded red-post-verify retry (regressed + budget → retry, else block-only) ──────
  //
  // A `'regressed'` attribution (evaluator-passed attempt that broke a GREEN baseline) sets the
  // ctx retry flag `lastShouldFailAttempt` IN ADDITION to `lastBlockReason` WHILE the task's
  // attempt budget remains. Settle's precedence then keeps the task in_progress for one more
  // attempt (the loop re-enters); the commit guard still skips on the block reason, so the red
  // work never lands. On budget exhaustion the flag is withheld → block only (today's behaviour).
  // Other attributions are untouched: only `'regressed'` ever arms the retry.
  describe('T6 red-post-verify bounded retry', () => {
    const runRegressed = async (attemptN: number, maxAttempts: number) => {
      const task = makeTaskOnAttempt(attemptN, maxAttempts);
      const ctx: ImplementCtx = {
        sprintId: SPRINT_ID,
        currentTask: task,
        currentTaskId: task.id,
        tasks: [task],
        lastPreVerifyOutcome: 'success', // green pre → a red post is `regressed`
      };
      const { repo } = fakeTaskRepo();
      const leaf = postTaskVerifyLeaf(
        {
          shellScriptRunner: fakeRunner({ passed: false, exitCode: 1, output: 'broke it' }),
          taskRepo: repo,
          gitRunner: fakeGitRunner(),
          clock: () => FIXED_NOW,
          eventBus: createCapturingBus().bus,
          logger: noopLogger,
        },
        { cwd: CWD, verifyScript: 'pnpm test', maxAttempts },
        task.id
      );
      const out = await leaf.execute(ctx);
      if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
      return out.value.ctx;
    };

    it('(a) regressed + budget remaining (attempt 1 of 3) → retry flag AND block reason both set', async () => {
      const ctx = await runRegressed(1, 3);
      expect(ctx.currentTask?.attempts.at(-1)?.attribution).toBe('regressed');
      expect(ctx.lastShouldFailAttempt).toBe(true);
      expect(ctx.lastBlockReason).toContain('regressed baseline');
    });

    it('(a2) regressed + budget remaining (attempt 2 of 3) → retry flag still set', async () => {
      const ctx = await runRegressed(2, 3);
      expect(ctx.lastShouldFailAttempt).toBe(true);
      expect(ctx.lastBlockReason).toContain('regressed baseline');
    });

    it('(b) regressed + budget exhausted (attempt 3 of 3, running attempt is spent) → block reason only, NO retry', async () => {
      // The explicit spec case: maxAttempts=3, running attempt n=3 → `3 < 3` is false → no retry.
      const ctx = await runRegressed(3, 3);
      expect(ctx.currentTask?.attempts.at(-1)?.attribution).toBe('regressed');
      expect(ctx.lastBlockReason).toContain('regressed baseline');
      expect(ctx.lastShouldFailAttempt).toBeUndefined();
    });

    it('budget boundary: maxAttempts=1, attempt 1 (the only allowed attempt) → block only, NO retry', async () => {
      const ctx = await runRegressed(1, 1);
      expect(ctx.lastBlockReason).toContain('regressed baseline');
      expect(ctx.lastShouldFailAttempt).toBeUndefined();
    });

    it('no maxAttempts wired (legacy caller) → block only, NO retry (pre-T6 behaviour preserved)', async () => {
      const task = makeInProgressTaskWithRunningAttempt();
      const ctx: ImplementCtx = {
        sprintId: SPRINT_ID,
        currentTask: task,
        currentTaskId: task.id,
        tasks: [task],
        lastPreVerifyOutcome: 'success',
      };
      const { repo } = fakeTaskRepo();
      const leaf = postTaskVerifyLeaf(
        {
          shellScriptRunner: fakeRunner({ passed: false, exitCode: 1, output: 'broke it' }),
          taskRepo: repo,
          gitRunner: fakeGitRunner(),
          clock: () => FIXED_NOW,
          eventBus: createCapturingBus().bus,
          logger: noopLogger,
        },
        { cwd: CWD, verifyScript: 'pnpm test' }, // no maxAttempts
        task.id
      );
      const out = await leaf.execute(ctx);
      if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
      expect(out.value.ctx.lastBlockReason).toContain('regressed baseline');
      expect(out.value.ctx.lastShouldFailAttempt).toBeUndefined();
    });

    const runWithPre = async (preOutcome: VerifyRunOutcome, postPassed: boolean) => {
      const task = makeTaskOnAttempt(1, 3); // budget wide open — isolates the attribution gate
      const ctx: ImplementCtx = {
        sprintId: SPRINT_ID,
        currentTask: task,
        currentTaskId: task.id,
        tasks: [task],
        lastPreVerifyOutcome: preOutcome,
      };
      const { repo } = fakeTaskRepo();
      const leaf = postTaskVerifyLeaf(
        {
          shellScriptRunner: fakeRunner({ passed: postPassed, exitCode: postPassed ? 0 : 1, output: 'x' }),
          taskRepo: repo,
          gitRunner: fakeGitRunner(),
          clock: () => FIXED_NOW,
          eventBus: createCapturingBus().bus,
          logger: noopLogger,
        },
        { cwd: CWD, verifyScript: 'pnpm test', maxAttempts: 3 },
        task.id
      );
      const out = await leaf.execute(ctx);
      if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
      return out.value.ctx;
    };

    it('(c) baseline-broken (pre=red, post=red) → no block, no retry flag (escape hatch untouched)', async () => {
      const ctx = await runWithPre('failed', false);
      expect(ctx.currentTask?.attempts.at(-1)?.attribution).toBe('baseline-broken');
      expect(ctx.lastBlockReason).toBeUndefined();
      expect(ctx.lastShouldFailAttempt).toBeUndefined();
    });

    it('(d) clean (pre=green, post=green) → neither block nor retry flag', async () => {
      const ctx = await runWithPre('success', true);
      expect(ctx.currentTask?.attempts.at(-1)?.attribution).toBe('clean');
      expect(ctx.lastBlockReason).toBeUndefined();
      expect(ctx.lastShouldFailAttempt).toBeUndefined();
    });

    it('(e) fixed-baseline (pre=red, post=green) → neither block nor retry flag', async () => {
      const ctx = await runWithPre('failed', true);
      expect(ctx.currentTask?.attempts.at(-1)?.attribution).toBe('fixed-baseline');
      expect(ctx.lastBlockReason).toBeUndefined();
      expect(ctx.lastShouldFailAttempt).toBeUndefined();
    });
  });
});
