/**
 * Per-command tests for the `sessions` group. Drives a real
 * SessionManager with a synthetic Element and asserts the CLI surface
 * (list / kill / detach) behaves as documented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Element, type ElementResult } from '../../../kernel/chain/element.ts';
import { Result } from '../../../domain/result.ts';
import { SessionManager } from '../../runtime/session-manager.ts';
import type { SharedDeps } from '../../bootstrap/shared-deps.ts';
import { runSessionsDetach } from './sessions-detach.ts';
import { runSessionsKill } from './sessions-kill.ts';
import { runSessionsList } from './sessions-list.ts';
import { EXIT_ERROR, EXIT_SUCCESS } from '../exit-codes.ts';

/** Element that hangs until aborted — useful for "running session" tests. */
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
            trace: [
              {
                stepName: this.name,
                status: 'aborted' as const,
                durationMs: 0,
                error: { code: 'aborted', message: 'aborted' },
              },
            ],
          })
        );
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      void ctx;
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
    return {
      result,
      io: { stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') },
    };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

function makeDeps(sessionManager: SessionManager): SharedDeps {
  return { sessionManager } as unknown as SharedDeps;
}

describe('sessions commands', () => {
  let sm: SessionManager;
  let deps: SharedDeps;

  beforeEach(() => {
    sm = new SessionManager();
    deps = makeDeps(sm);
  });

  afterEach(async () => {
    await sm.dispose();
  });

  describe('list', () => {
    it('reports an empty list when nothing has started', async () => {
      const { result, io } = await captureIo(() => runSessionsList(deps));
      expect(result).toBe(EXIT_SUCCESS);
      expect(io.stdout).toContain('No active sessions');
    });

    it('shows registered sessions with status', async () => {
      sm.start({
        label: 'work',
        element: new HangingElement(),
        initialCtx: { tag: 'a' },
      });
      // Status flips to 'running' on the next microtask after the runner emits 'started'.
      await new Promise((r) => setImmediate(r));
      const { result, io } = await captureIo(() => runSessionsList(deps));
      expect(result).toBe(EXIT_SUCCESS);
      expect(io.stdout).toContain('work');
    });

    it('marks the active session', async () => {
      const id = sm.start({
        label: 'one',
        element: new HangingElement(),
        initialCtx: { tag: 'a' },
      });
      sm.foreground(id);
      await new Promise((r) => setImmediate(r));
      const { io } = await captureIo(() => runSessionsList(deps));
      // Just check the marker glyph is present — colorette wraps it in ANSI
      // when colors are on, breaking a stricter `* ` regex on CI.
      expect(io.stdout).toContain('*');
    });
  });

  describe('kill', () => {
    it('aborts a running session', async () => {
      const id = sm.start({
        label: 'soon-dead',
        element: new HangingElement(),
        initialCtx: { tag: 'a' },
      });
      const { result } = await captureIo(() => runSessionsKill(deps, id));
      expect(result).toBe(EXIT_SUCCESS);
      expect(sm.get(id)).toBeUndefined();
    });

    it('fails on unknown id', async () => {
      const { result, io } = await captureIo(() => runSessionsKill(deps, 'ghost'));
      expect(result).toBe(EXIT_ERROR);
      expect(io.stderr).toContain('error');
    });
  });

  describe('detach', () => {
    it('drops the active marker', async () => {
      const id = sm.start({
        label: 'one',
        element: new HangingElement(),
        initialCtx: { tag: 'a' },
      });
      sm.foreground(id);
      const { result } = await captureIo(() => runSessionsDetach(deps, id));
      expect(result).toBe(EXIT_SUCCESS);
      expect(sm.active).toBeNull();
    });

    it('fails on unknown id', async () => {
      const { result } = await captureIo(() => runSessionsDetach(deps, 'ghost'));
      expect(result).toBe(EXIT_ERROR);
    });
  });
});
