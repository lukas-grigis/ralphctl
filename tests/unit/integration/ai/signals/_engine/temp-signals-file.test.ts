import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { allocSignalsTempPath, withSignalsTempPath } from '@src/integration/ai/signals/_engine/temp-signals-file.ts';

describe('allocSignalsTempPath', () => {
  it('returns a path inside the OS tempdir tagged with the label and the pid', () => {
    const r = allocSignalsTempPath('my-flow');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = String(r.value);
    expect(s).toMatch(/ralphctl-signals-my-flow-/);
    expect(s).toContain(String(process.pid));
    expect(s.endsWith('.json')).toBe(true);
  });

  it('emits a different path on each call (monotonic counter)', () => {
    const a = allocSignalsTempPath('x');
    const b = allocSignalsTempPath('x');
    expect(a.ok && b.ok && String(a.value) !== String(b.value)).toBe(true);
  });
});

describe('withSignalsTempPath', () => {
  it('passes the allocated path into the callback and resolves with its result', async () => {
    const r = await withSignalsTempPath('happy', async (signalsFile) => {
      expect(String(signalsFile)).toMatch(/ralphctl-signals-happy-/);
      return Result.ok('payload');
    });
    expect(r.ok && r.value).toBe('payload');
  });

  it('unlinks the signals file after the callback resolves', async () => {
    let capturedPath = '';
    const r = await withSignalsTempPath('cleanup', async (signalsFile) => {
      capturedPath = String(signalsFile);
      // Simulate the provider writing the file mid-flight.
      await fs.writeFile(capturedPath, '[]', 'utf8');
      // Sanity: file exists right now.
      await expect(fs.access(capturedPath)).resolves.toBeUndefined();
      return Result.ok(undefined);
    });
    expect(r.ok).toBe(true);
    // After the combinator returns, the file is gone.
    await expect(fs.access(capturedPath)).rejects.toThrow();
  });

  it('still unlinks the file when the callback returns Result.error', async () => {
    let capturedPath = '';
    await withSignalsTempPath('error-cleanup', async (signalsFile) => {
      capturedPath = String(signalsFile);
      await fs.writeFile(capturedPath, '[]', 'utf8');
      return Result.error(
        new InvalidStateError({
          entity: 'test',
          currentState: 'x',
          attemptedAction: 'y',
          message: 'inside-callback failure',
        })
      );
    });
    await expect(fs.access(capturedPath)).rejects.toThrow();
  });

  it('still unlinks the file when the callback throws', async () => {
    let capturedPath = '';
    await expect(
      withSignalsTempPath('throw-cleanup', async (signalsFile) => {
        capturedPath = String(signalsFile);
        await fs.writeFile(capturedPath, '[]', 'utf8');
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    await expect(fs.access(capturedPath)).rejects.toThrow();
  });

  it('does not crash when the callback never wrote the file (cleanup is best-effort)', async () => {
    // The callback may bail before the provider runs; unlink should fail silently.
    const r = await withSignalsTempPath('no-file', async () => Result.ok('done'));
    expect(r.ok && r.value).toBe('done');
  });
});
