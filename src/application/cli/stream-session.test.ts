/**
 * Tests for `streamSession` — the helper that workflow commands use to
 * launch a chain via SessionManager and render its events to stdout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Element, type ElementResult } from '../../kernel/chain/element.ts';
import { Result } from '../../domain/result.ts';
import { SessionManager } from '../runtime/session-manager.ts';
import { streamSession } from './stream-session.ts';
import { EXIT_ERROR, EXIT_SUCCESS } from './exit-codes.ts';

class CompletingElement extends Element<{ readonly value: number }> {
  constructor() {
    super('demo');
  }
  protected run(ctx: { readonly value: number }): Promise<ElementResult<{ readonly value: number }>> {
    return Promise.resolve(
      Result.ok({
        ctx,
        trace: [{ stepName: 'demo', status: 'completed' as const, durationMs: 5 }],
      })
    );
  }
}

class FailingElement extends Element<{ readonly tag: string }> {
  constructor() {
    super('boom');
  }
  protected run(): Promise<ElementResult<{ readonly tag: string }>> {
    const err = { code: 'boom', message: 'boom happened' };
    return Promise.resolve(
      Result.error({
        error: err,
        trace: [{ stepName: 'boom', status: 'failed' as const, durationMs: 0, error: err }],
      })
    );
  }
}

interface CapturedIo {
  readonly stdout: string;
  readonly stderr: string;
}

async function captureIo<T>(body: () => Promise<T>): Promise<{ result: T; io: CapturedIo }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  });
  try {
    const result = await body();
    return { result, io: { stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') } };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

describe('streamSession', () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager();
  });

  afterEach(async () => {
    await sm.dispose();
  });

  it('returns EXIT_SUCCESS when the chain completes', async () => {
    const { result, io } = await captureIo(() =>
      streamSession({
        sessionManager: sm,
        label: 'happy',
        element: new CompletingElement(),
        initialCtx: { value: 1 },
      })
    );
    expect(result).toBe(EXIT_SUCCESS);
    expect(io.stdout).toContain('demo');
    expect(io.stdout).toContain('done');
  });

  it('returns EXIT_ERROR when the chain fails', async () => {
    const { result, io } = await captureIo(() =>
      streamSession({
        sessionManager: sm,
        label: 'sad',
        element: new FailingElement(),
        initialCtx: { tag: 'x' },
      })
    );
    expect(result).toBe(EXIT_ERROR);
    expect(io.stdout).toContain('failed');
    expect(io.stdout).toContain('boom');
  });

  it('prints session id at startup', async () => {
    const { io } = await captureIo(() =>
      streamSession({
        sessionManager: sm,
        label: 'tagged',
        element: new CompletingElement(),
        initialCtx: { value: 1 },
      })
    );
    expect(io.stdout).toContain('session');
    expect(io.stdout).toContain('tagged');
  });
});
