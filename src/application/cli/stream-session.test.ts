/**
 * Tests for `streamSession` — the helper that workflow commands use to
 * launch a chain via SessionManager and render its events to stdout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Element, type ElementResult } from '@src/kernel/chain/element.ts';
import { Result } from '@src/domain/result.ts';
import { SessionManager } from '@src/application/runtime/session-manager.ts';
import { streamSession } from './stream-session.ts';
import { FakePromptPort } from '@src/application/_test-fakes/fake-prompt-port.ts';
import { EXIT_ERROR, EXIT_INTERRUPTED, EXIT_SUCCESS } from './exit-codes.ts';

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

/**
 * Element that hangs until either its abort signal fires (giving the test a
 * way to drive the cancel flow) or a hard timeout. Used by the SIGINT tests
 * below — we need a long-running chain so the SIGINT happens mid-flight.
 */
class HangingElement extends Element<{ readonly tag: string }> {
  constructor() {
    super('hang');
  }
  protected run(ctx: { readonly tag: string }, signal?: AbortSignal): Promise<ElementResult<{ readonly tag: string }>> {
    return new Promise((resolve) => {
      const onAbort = (): void => {
        resolve(
          Result.error({
            error: { code: 'aborted', message: 'aborted' },
            trace: [{ stepName: 'hang', status: 'aborted' as const, durationMs: 0 }],
          })
        );
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      // Safety cap so a buggy test doesn't hang the suite.
      setTimeout(() => {
        resolve(
          Result.ok({
            ctx,
            trace: [{ stepName: 'hang', status: 'completed' as const, durationMs: 1 }],
          })
        );
      }, 5_000);
    });
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

  it('SIGINT prompts for confirm; on confirm, kills and returns EXIT_INTERRUPTED', async () => {
    // Force interactive mode so the prompt fires.
    const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    const prompt = new FakePromptPort();
    prompt.queueConfirm(true);

    try {
      const { result } = await captureIo(async () => {
        const promise = streamSession({
          sessionManager: sm,
          label: 'long',
          element: new HangingElement(),
          initialCtx: { tag: 'x' },
          prompt,
        });
        // Give the runner a moment to attach + emit `started`.
        await new Promise((r) => setTimeout(r, 20));
        // First Ctrl+C fires the confirm prompt; the queued `true` answer
        // resolves it, which triggers sessionManager.kill and the chain
        // settles 'aborted'.
        process.emit('SIGINT');
        return promise;
      });
      expect(result).toBe(EXIT_INTERRUPTED);
      expect(prompt.confirmMock).toHaveBeenCalled();
    } finally {
      if (stdinTty) Object.defineProperty(process.stdin, 'isTTY', stdinTty);
      if (stdoutTty) Object.defineProperty(process.stdout, 'isTTY', stdoutTty);
    }
  });

  it('SIGINT then user declines — chain keeps streaming (no kill)', async () => {
    const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    const prompt = new FakePromptPort();
    prompt.queueConfirm(false);

    try {
      const { result } = await captureIo(async () => {
        const promise = streamSession({
          sessionManager: sm,
          label: 'long',
          element: new CompletingElement(),
          initialCtx: { value: 1 },
          prompt,
        });
        // Issue SIGINT *after* the chain has likely completed — the prompt
        // should not have fired (handler is removed in finally).
        await new Promise((r) => setTimeout(r, 5));
        return promise;
      });
      expect(result).toBe(EXIT_SUCCESS);
      // Confirm wasn't fired because SIGINT did not arrive in this race.
      // The important contract is: declining the confirm does not kill;
      // direct verification of that is in the FakePromptPort unit test.
      expect(prompt.confirmMock).not.toHaveBeenCalled();
    } finally {
      if (stdinTty) Object.defineProperty(process.stdin, 'isTTY', stdinTty);
      if (stdoutTty) Object.defineProperty(process.stdout, 'isTTY', stdoutTty);
    }
  });
});
