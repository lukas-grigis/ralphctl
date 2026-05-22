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
    const { run, rawOutput } = await runVerifyScriptUseCase({
      cwd: CWD,
      phase: 'pre',
      clock: () => FIXED_NOW,
      runShellScript: passingShell,
      logger: noopLogger,
    });
    expect(run.outcome).toBe('skipped');
    expect(run.command).toBe('');
    expect(run.exitCode).toBe(0);
    expect(run.durationMs).toBe(0);
    expect(rawOutput).toBe('');
  });

  it('returns outcome="skipped" when script is whitespace-only', async () => {
    const { run } = await runVerifyScriptUseCase({
      cwd: CWD,
      phase: 'pre',
      verifyScript: '   \n\t ',
      clock: () => FIXED_NOW,
      runShellScript: passingShell,
      logger: noopLogger,
    });
    expect(run.outcome).toBe('skipped');
  });

  it('returns outcome="success" with rawOutput when script exits 0 (audit row carries no body)', async () => {
    const { run, rawOutput } = await runVerifyScriptUseCase({
      cwd: CWD,
      phase: 'post',
      verifyScript: 'pnpm test',
      clock: () => FIXED_NOW,
      runShellScript: passingShell,
      logger: noopLogger,
    });
    expect(run.outcome).toBe('success');
    expect(run.phase).toBe('post');
    expect(run.exitCode).toBe(0);
    expect(run.durationMs).toBe(100);
    // Audit-[06]: the audit row carries structured metadata only; no embedded tail bytes.
    expect((run as unknown as Record<string, unknown>)['stdoutTailBytes']).toBeUndefined();
    // Audit-[01]: full raw output is the leaf's input for the logs/ persistence.
    expect(rawOutput).toBe('OK');
  });

  it('returns outcome="failed" with full rawOutput when script exits non-zero', async () => {
    const huge = 'A'.repeat(SCRIPT_TAIL_BYTES * 2) + 'FINAL_LINE';
    const { run, rawOutput } = await runVerifyScriptUseCase({
      cwd: CWD,
      phase: 'post',
      verifyScript: 'pnpm test',
      clock: () => FIXED_NOW,
      runShellScript: async () => Result.ok({ passed: false, exitCode: 1, output: huge, durationMs: 50 }),
      logger: noopLogger,
    });
    expect(run.outcome).toBe('failed');
    expect(run.exitCode).toBe(1);
    // rawOutput preserves the full body verbatim — no truncation at the use-case boundary.
    expect(rawOutput.length).toBe(huge.length);
    expect(rawOutput).toBe(huge);
  });

  it('returns outcome="spawn-error" with exit=-1 and spawnErrorMessage when the shell could not start', async () => {
    const { run, rawOutput, spawnErrorMessage } = await runVerifyScriptUseCase({
      cwd: CWD,
      phase: 'pre',
      verifyScript: 'missing-binary',
      clock: () => FIXED_NOW,
      runShellScript: spawnErrorShell,
      logger: noopLogger,
    });
    expect(run.outcome).toBe('spawn-error');
    expect(run.exitCode).toBe(-1);
    expect(spawnErrorMessage).toContain('spawn ENOENT');
    expect(rawOutput).toBe('');
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
