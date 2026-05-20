import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { absolutePath, FIXED_NOW, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { CheckRunOutcome } from '@src/domain/entity/attempt.ts';
import { postTaskCheckLeaf } from '@src/application/flows/implement/leaves/post-task-check.ts';
import type { ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';

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
  readonly leaf: ReturnType<typeof postTaskCheckLeaf>;
}

const fixture = (
  runner: ShellScriptRunner,
  opts: { preOutcome?: CheckRunOutcome; checkScript?: string } = {}
): Fixture => {
  const task = makeInProgressTaskWithRunningAttempt();
  const ctx: ImplementCtx = {
    sprintId: SPRINT_ID,
    currentTask: task,
    currentTaskId: task.id,
    tasks: [task],
    ...(opts.preOutcome !== undefined ? { lastPreCheckOutcome: opts.preOutcome } : {}),
  };
  const { repo } = fakeTaskRepo();
  const bus = createCapturingBus();
  const leaf = postTaskCheckLeaf(
    {
      shellScriptRunner: runner,
      taskRepo: repo,
      clock: () => FIXED_NOW,
      eventBus: bus.bus,
      logger: noopLogger,
    },
    { cwd: CWD, ...(opts.checkScript !== undefined ? { checkScript: opts.checkScript } : {}) },
    task.id
  );
  return { ctx, leaf };
};

describe('postTaskCheckLeaf', () => {
  it('skips when no checkScript configured — `lastVerifyResult` is "skipped", no attribution', async () => {
    const { ctx, leaf } = fixture(fakeRunner({ passed: true, exitCode: 0, output: '' }), { preOutcome: 'success' });
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(out.value.ctx.lastVerifyResult?.kind).toBe('skipped');
    expect(out.value.ctx.currentTask?.attempts.at(-1)?.attribution).toBeUndefined();
  });

  it('marks passed when script runs green and persists a CheckRun row', async () => {
    const { ctx, leaf } = fixture(fakeRunner({ passed: true, exitCode: 0, output: 'OK' }), {
      preOutcome: 'success',
      checkScript: 'pnpm test',
    });
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(out.value.ctx.lastVerifyResult?.kind).toBe('passed');
    const row = out.value.ctx.currentTask?.attempts.at(-1)?.checkRuns?.[0];
    expect(row?.phase).toBe('post');
    expect(row?.outcome).toBe('success');
    expect(row?.exitCode).toBe(0);
  });

  it('marks verify-failed with exitCode + truncated stderr when red', async () => {
    const longOutput = `${'x'.repeat(5000)}\nFINAL_LINE`;
    const { ctx, leaf } = fixture(fakeRunner({ passed: false, exitCode: 1, output: longOutput }), {
      preOutcome: 'success',
      checkScript: 'pnpm test',
    });
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    const v = out.value.ctx.lastVerifyResult;
    expect(v?.kind).toBe('verify-failed');
    if (v?.kind === 'verify-failed') {
      expect(v.exitCode).toBe(1);
      expect(v.stderr).toContain('FINAL_LINE');
      expect(v.stderr).toContain('truncated');
    }
  });

  it('attribution truth table — pre=green, post=green → clean (no block)', async () => {
    const { ctx, leaf } = fixture(fakeRunner({ passed: true, exitCode: 0, output: '' }), {
      preOutcome: 'success',
      checkScript: 'pnpm test',
    });
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(out.value.ctx.currentTask?.attempts.at(-1)?.attribution).toBe('clean');
    expect(out.value.ctx.lastBlockReason).toBeUndefined();
  });

  it('attribution truth table — pre=green, post=red → regressed (block)', async () => {
    const { ctx, leaf } = fixture(fakeRunner({ passed: false, exitCode: 7, output: 'broke it' }), {
      preOutcome: 'success',
      checkScript: 'pnpm test',
    });
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(out.value.ctx.currentTask?.attempts.at(-1)?.attribution).toBe('regressed');
    expect(out.value.ctx.lastBlockReason).toContain('regressed baseline');
    expect(out.value.ctx.lastBlockReason).toContain('exit=7');
  });

  it('attribution truth table — pre=red, post=red → baseline-broken (preserve verdict, NO block)', async () => {
    const { ctx, leaf } = fixture(fakeRunner({ passed: false, exitCode: 1, output: 'still red' }), {
      preOutcome: 'failed',
      checkScript: 'pnpm test',
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
      checkScript: 'pnpm test',
    });
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(out.value.ctx.currentTask?.attempts.at(-1)?.attribution).toBe('fixed-baseline');
    expect(out.value.ctx.lastBlockReason).toBeUndefined();
  });

  it('spawn-error pre-check → attribution skipped, post row still recorded as spawn-error', async () => {
    const { ctx, leaf } = fixture(errorRunner('binary missing'), {
      preOutcome: 'spawn-error',
      checkScript: 'pnpm test',
    });
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(out.value.ctx.currentTask?.attempts.at(-1)?.attribution).toBeUndefined();
    const row = out.value.ctx.currentTask?.attempts.at(-1)?.checkRuns?.[0];
    expect(row?.outcome).toBe('spawn-error');
  });

  it('persists the running attempt with the appended CheckRun via taskRepo.update', async () => {
    const task = makeInProgressTaskWithRunningAttempt();
    const ctx: ImplementCtx = {
      sprintId: SPRINT_ID,
      currentTask: task,
      currentTaskId: task.id,
      tasks: [task],
      lastPreCheckOutcome: 'success',
    };
    const { repo } = fakeTaskRepo();
    const bus = createCapturingBus();
    const leaf = postTaskCheckLeaf(
      {
        shellScriptRunner: fakeRunner({ passed: true, exitCode: 0, output: 'ok' }),
        taskRepo: repo,
        clock: () => FIXED_NOW,
        eventBus: bus.bus,
        logger: noopLogger,
      },
      { cwd: CWD, checkScript: 'pnpm test' },
      task.id
    );
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(repo.updates).toHaveLength(1);
    const persistedRows = repo.updates[0]?.attempts.at(-1)?.checkRuns;
    expect(persistedRows).toHaveLength(1);
    expect(persistedRows?.[0]?.phase).toBe('post');
    expect(persistedRows?.[0]?.outcome).toBe('success');
  });
});
