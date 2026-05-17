import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { preflightTaskUseCase } from '@src/business/task/preflight-task.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

const CWD = absolutePath('/tmp/repo');

const okCount = (n: number) => async (_cwd: AbsolutePath) => {
  void _cwd;
  return Result.ok(n);
};
const failCount = async (_cwd: AbsolutePath) => {
  void _cwd;
  return Result.error(new StorageError({ subCode: 'io', message: 'git status exploded' }));
};

describe('preflightTaskUseCase', () => {
  it('returns ok on a clean working tree', async () => {
    const result = await preflightTaskUseCase({
      cwd: CWD,
      gitStatusEntryCount: okCount(0),
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a dirty tree with InvalidStateError under the default policy ('cancel')", async () => {
    const result = await preflightTaskUseCase({
      cwd: CWD,
      gitStatusEntryCount: okCount(3),
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-state');
      expect(result.error.message).toContain('3 uncommitted change');
      expect(result.error.message).toContain(String(CWD));
    }
  });

  it("rejects a dirty tree when policy is explicitly 'cancel'", async () => {
    const result = await preflightTaskUseCase({
      cwd: CWD,
      gitStatusEntryCount: okCount(1),
      dirtyTreePolicy: 'cancel',
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
  });

  it("returns ok on a dirty tree when policy is 'continue' (operator override)", async () => {
    const result = await preflightTaskUseCase({
      cwd: CWD,
      gitStatusEntryCount: okCount(7),
      dirtyTreePolicy: 'continue',
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
  });

  it('propagates StorageError when git status itself fails', async () => {
    const result = await preflightTaskUseCase({
      cwd: CWD,
      gitStatusEntryCount: failCount,
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('storage-error');
  });
});
