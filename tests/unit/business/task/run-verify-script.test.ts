import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { absolutePath, FIXED_NOW } from '@tests/fixtures/domain.ts';
import { attributeVerify, runVerifyScriptUseCase } from '@src/business/task/run-verify-script.ts';
import { SCRIPT_TAIL_BYTES } from '@src/domain/value/script-tail-bytes.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';

const CWD = absolutePath('/tmp/repo');

const passingShell: Parameters<typeof runVerifyScriptUseCase>[0]['runShellScript'] = async () =>
  Result.ok({ passed: true, exitCode: 0, output: 'OK', durationMs: 100 });

const spawnErrorShell: Parameters<typeof runVerifyScriptUseCase>[0]['runShellScript'] = async () =>
  Result.error(new StorageError({ subCode: 'io', message: 'spawn ENOENT: command not found' }));

describe('runVerifyScriptUseCase', () => {
  it('returns outcome="skipped" when no script configured', async () => {
    const row = await runVerifyScriptUseCase({
      cwd: CWD,
      phase: 'pre',
      clock: () => FIXED_NOW,
      runShellScript: passingShell,
      logger: noopLogger,
    });
    expect(row.outcome).toBe('skipped');
    expect(row.command).toBe('');
    expect(row.exitCode).toBe(0);
    expect(row.durationMs).toBe(0);
  });

  it('returns outcome="skipped" when script is whitespace-only', async () => {
    const row = await runVerifyScriptUseCase({
      cwd: CWD,
      phase: 'pre',
      verifyScript: '   \n\t ',
      clock: () => FIXED_NOW,
      runShellScript: passingShell,
      logger: noopLogger,
    });
    expect(row.outcome).toBe('skipped');
  });

  it('returns outcome="success" with stdoutTail when script exits 0', async () => {
    const row = await runVerifyScriptUseCase({
      cwd: CWD,
      phase: 'post',
      verifyScript: 'pnpm test',
      clock: () => FIXED_NOW,
      runShellScript: passingShell,
      logger: noopLogger,
    });
    expect(row.outcome).toBe('success');
    expect(row.phase).toBe('post');
    expect(row.exitCode).toBe(0);
    expect(row.durationMs).toBe(100);
    expect(row.stdoutTailBytes).toBe('OK');
  });

  it('returns outcome="failed" with truncated stdoutTail when script exits non-zero', async () => {
    const huge = 'A'.repeat(SCRIPT_TAIL_BYTES * 2) + 'FINAL_LINE';
    const row = await runVerifyScriptUseCase({
      cwd: CWD,
      phase: 'post',
      verifyScript: 'pnpm test',
      clock: () => FIXED_NOW,
      runShellScript: async () => Result.ok({ passed: false, exitCode: 1, output: huge, durationMs: 50 }),
      logger: noopLogger,
    });
    expect(row.outcome).toBe('failed');
    expect(row.exitCode).toBe(1);
    expect(row.stdoutTailBytes).toContain('FINAL_LINE');
    expect(row.stdoutTailBytes).toContain('truncated');
    // Tail body itself is capped at the limit; the marker prefix adds a small overhead.
    expect(Buffer.from(row.stdoutTailBytes, 'utf8').length).toBeLessThan(SCRIPT_TAIL_BYTES + 200);
  });

  it('returns outcome="spawn-error" with exit=-1 when the shell could not start', async () => {
    const row = await runVerifyScriptUseCase({
      cwd: CWD,
      phase: 'pre',
      verifyScript: 'missing-binary',
      clock: () => FIXED_NOW,
      runShellScript: spawnErrorShell,
      logger: noopLogger,
    });
    expect(row.outcome).toBe('spawn-error');
    expect(row.exitCode).toBe(-1);
    expect(row.stdoutTailBytes).toContain('spawn ENOENT');
  });

  it('does NOT call the shell when the script is skipped (no side effects on no-op)', async () => {
    let called = false;
    await runVerifyScriptUseCase({
      cwd: CWD,
      phase: 'pre',
      clock: () => FIXED_NOW,
      runShellScript: async () => {
        called = true;
        return Result.ok({ passed: true, exitCode: 0, output: '', durationMs: 0 });
      },
      logger: noopLogger,
    });
    expect(called).toBe(false);
  });
});

describe('attributeVerify — truth table', () => {
  it('pre=success, post=success → clean', () => {
    expect(attributeVerify('success', 'success')).toBe('clean');
  });

  it('pre=success, post=failed → regressed', () => {
    expect(attributeVerify('success', 'failed')).toBe('regressed');
  });

  it('pre=failed, post=success → fixed-baseline', () => {
    expect(attributeVerify('failed', 'success')).toBe('fixed-baseline');
  });

  it('pre=failed, post=failed → baseline-broken', () => {
    expect(attributeVerify('failed', 'failed')).toBe('baseline-broken');
  });

  it('pre=spawn-error → undefined (unknown baseline state)', () => {
    expect(attributeVerify('spawn-error', 'success')).toBeUndefined();
    expect(attributeVerify('spawn-error', 'failed')).toBeUndefined();
    expect(attributeVerify('spawn-error', 'spawn-error')).toBeUndefined();
  });

  it('post=spawn-error → undefined (verdict could not run)', () => {
    expect(attributeVerify('success', 'spawn-error')).toBeUndefined();
    expect(attributeVerify('failed', 'spawn-error')).toBeUndefined();
  });

  it('either side=skipped → undefined (nothing to attribute)', () => {
    expect(attributeVerify('skipped', 'skipped')).toBeUndefined();
    expect(attributeVerify('skipped', 'success')).toBeUndefined();
    expect(attributeVerify('skipped', 'failed')).toBeUndefined();
    expect(attributeVerify('success', 'skipped')).toBeUndefined();
    expect(attributeVerify('failed', 'skipped')).toBeUndefined();
  });
});
