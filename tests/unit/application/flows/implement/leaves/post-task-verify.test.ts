import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { absolutePath, FIXED_NOW, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { VerifyRunOutcome } from '@src/domain/entity/attempt.ts';
import { postTaskVerifyLeaf } from '@src/application/flows/implement/leaves/post-task-verify.ts';
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
});
