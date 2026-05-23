import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { absolutePath, FIXED_NOW, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { preTaskVerifyLeaf } from '@src/application/flows/implement/leaves/pre-task-verify.ts';
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

interface Fixture {
  readonly ctx: ImplementCtx;
  readonly leaf: ReturnType<typeof preTaskVerifyLeaf>;
  readonly repo: FakeRepo;
}

const fixture = (runner: ShellScriptRunner, opts: { verifyScript?: string } = {}): Fixture => {
  const task = makeInProgressTaskWithRunningAttempt();
  const ctx: ImplementCtx = {
    sprintId: SPRINT_ID,
    currentTask: task,
    currentTaskId: task.id,
    tasks: [task],
  };
  const repo = fakeTaskRepo();
  const bus = createCapturingBus();
  const leaf = preTaskVerifyLeaf(
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
  return { ctx, leaf, repo };
};

describe('preTaskVerifyLeaf', () => {
  it('skipped row when no verifyScript configured — no baselineBroken, lastPreVerifyOutcome="skipped"', async () => {
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

  it('records pre-row outcome="failed" AND stamps baselineBroken=true when script runs red — NEVER blocks', async () => {
    const { ctx, leaf, repo } = fixture(fakeRunner({ passed: false, exitCode: 1, output: 'broken' }), {
      verifyScript: 'pnpm test',
    });
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(out.value.ctx.lastPreVerifyOutcome).toBe('failed');
    const att = out.value.ctx.currentTask?.attempts.at(-1);
    expect(att?.verifyRuns?.[0]?.outcome).toBe('failed');
    expect(att?.baselineBroken).toBe(true);
    // Pre-verify is NEVER blocking — it just records baseline state.
    expect(out.value.ctx.lastBlockReason).toBeUndefined();
    expect(repo.updates).toHaveLength(1);
  });

  it('records pre-row outcome="spawn-error" when shell could not start — no baselineBroken (unknown state)', async () => {
    const { ctx, leaf, repo } = fixture(errorRunner('command not found'), { verifyScript: 'missing-binary' });
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(out.value.ctx.lastPreVerifyOutcome).toBe('spawn-error');
    const att = out.value.ctx.currentTask?.attempts.at(-1);
    expect(att?.verifyRuns?.[0]?.outcome).toBe('spawn-error');
    // Wave 8: spawn-error message lands on the bus log (not on the audit row).
    // spawn-error is NOT known-bad baseline — leave the flag unset so attribution is skipped
    // downstream rather than mis-attributing.
    expect(att?.baselineBroken).toBeUndefined();
    expect(repo.updates).toHaveLength(1);
  });

  it('persists the running attempt with the appended VerifyRun via taskRepo.update', async () => {
    const { ctx, leaf, repo } = fixture(fakeRunner({ passed: true, exitCode: 0, output: 'ok' }), {
      verifyScript: 'pnpm test',
    });
    const out = await leaf.execute(ctx);
    if (!out.ok) throw new Error(`expected ok: ${out.error.error.message}`);
    expect(repo.updates).toHaveLength(1);
    const persistedRows = repo.updates[0]?.attempts.at(-1)?.verifyRuns;
    expect(persistedRows).toHaveLength(1);
    expect(persistedRows?.[0]?.phase).toBe('pre');
  });

  it('throws InvalidStateError when ctx.currentTask is missing', async () => {
    const { leaf } = fixture(fakeRunner({ passed: true, exitCode: 0, output: '' }));
    const out = await leaf.execute({ sprintId: SPRINT_ID });
    expect(out.ok).toBe(false);
  });
});
