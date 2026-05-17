import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { TaskId } from '@src/domain/value/id/task-id.ts';
import { postTaskCheckLeaf } from '@src/application/flows/implement/leaves/post-task-check.ts';
import type { ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
const CWD = absolutePath('/tmp/repo');

const TASK_ID = ((): TaskId => {
  const id = TaskId.parse('0193ed2b-5678-7abc-8def-fedcba987654');
  if (!id.ok) throw new Error('test setup');
  return id.value;
})();

const baseCtx = (): ImplementCtx => {
  const sid = SprintId.parse('0193ed2b-1234-7abc-8def-0123456789ab');
  if (!sid.ok) throw new Error('test setup');
  return { sprintId: sid.value };
};

const fakeRunner = (result: { passed: boolean; exitCode: number | null; output: string }): ShellScriptRunner => ({
  async run() {
    return Result.ok({ ...result, durationMs: 0 });
  },
});

describe('postTaskCheckLeaf', () => {
  it('skips when no checkScript configured', async () => {
    const leaf = postTaskCheckLeaf(
      { shellScriptRunner: fakeRunner({ passed: true, exitCode: 0, output: '' }), logger: noopLogger },
      { cwd: CWD },
      TASK_ID
    );
    const out = await leaf.execute(baseCtx());
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.ctx.lastVerifyResult?.kind).toBe('skipped');
  });

  it('marks passed when script runs green', async () => {
    const leaf = postTaskCheckLeaf(
      { shellScriptRunner: fakeRunner({ passed: true, exitCode: 0, output: '' }), logger: noopLogger },
      { cwd: CWD, checkScript: 'pnpm test' },
      TASK_ID
    );
    const out = await leaf.execute(baseCtx());
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.ctx.lastVerifyResult?.kind).toBe('passed');
  });

  it('marks verify-failed with exitCode + truncated stderr when red', async () => {
    const longOutput = `${'x'.repeat(5000)}\nFINAL_LINE`;
    const leaf = postTaskCheckLeaf(
      {
        shellScriptRunner: fakeRunner({ passed: false, exitCode: 1, output: longOutput }),
        logger: noopLogger,
      },
      { cwd: CWD, checkScript: 'pnpm test' },
      TASK_ID
    );
    const out = await leaf.execute(baseCtx());
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.ctx.lastVerifyResult?.kind).toBe('verify-failed');
      if (out.value.ctx.lastVerifyResult?.kind === 'verify-failed') {
        expect(out.value.ctx.lastVerifyResult.exitCode).toBe(1);
        expect(out.value.ctx.lastVerifyResult.stderr).toContain('FINAL_LINE');
        expect(out.value.ctx.lastVerifyResult.stderr).toContain('truncated');
      }
    }
  });

  it('propagates spawn-level failures as DomainError', async () => {
    const errored: ShellScriptRunner = {
      async run() {
        return Result.error({
          code: 'storage-error',
          subCode: 'io',
          path: undefined,
          cause: undefined,
          name: 'StorageError',
          message: 'shell missing',
        } as never);
      },
    };
    const leaf = postTaskCheckLeaf(
      { shellScriptRunner: errored, logger: noopLogger },
      { cwd: CWD, checkScript: 'pnpm test' },
      TASK_ID
    );
    const out = await leaf.execute(baseCtx());
    expect(out.ok).toBe(false);
  });
});
