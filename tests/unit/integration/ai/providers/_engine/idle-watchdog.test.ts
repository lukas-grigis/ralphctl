import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_IDLE_MS, installIdleWatchdog } from '@src/integration/ai/providers/_engine/idle-watchdog.ts';

/**
 * Minimal fake child process exposing the surface the watchdog reads: stdout / stderr event
 * emitters and a `kill` method. `kill` records the signal so tests can assert the SIGTERM →
 * SIGKILL ladder fired in the right order.
 */
const makeFakeChild = (): {
  readonly child: ChildProcessWithoutNullStreams;
  readonly kills: string[];
  readonly emitStdout: (chunk: string) => void;
  readonly emitStderr: (chunk: string) => void;
} => {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const kills: string[] = [];
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    stdout,
    stderr,
    kill: (sig: NodeJS.Signals): boolean => {
      kills.push(String(sig));
      return true;
    },
  });
  return {
    child,
    kills,
    emitStdout: (chunk: string) => stdout.emit('data', chunk),
    emitStderr: (chunk: string) => stderr.emit('data', chunk),
  };
};

describe('installIdleWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends SIGTERM after `idleMs` of stdio silence and fires `onIdle` exactly once', () => {
    const { child, kills } = makeFakeChild();
    const onIdle = vi.fn();
    installIdleWatchdog(child, { idleMs: 1000, graceMs: 500, onIdle });

    vi.advanceTimersByTime(999);
    expect(kills).toEqual([]);
    expect(onIdle).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(kills).toEqual(['SIGTERM']);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('escalates to SIGKILL after `graceMs` if the child traps SIGTERM and keeps running', () => {
    const { child, kills } = makeFakeChild();
    installIdleWatchdog(child, { idleMs: 1000, graceMs: 500 });

    vi.advanceTimersByTime(1000); // SIGTERM
    vi.advanceTimersByTime(499);
    expect(kills).toEqual(['SIGTERM']);
    vi.advanceTimersByTime(1);
    expect(kills).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('resets the idle timer on each stdout chunk — productive sessions never trip', () => {
    const { child, kills, emitStdout } = makeFakeChild();
    installIdleWatchdog(child, { idleMs: 1000 });

    // Streaming session: tokens every 400ms across 3 ticks.
    vi.advanceTimersByTime(400);
    emitStdout('chunk');
    vi.advanceTimersByTime(400);
    emitStdout('chunk');
    vi.advanceTimersByTime(400);
    emitStdout('chunk');
    expect(kills).toEqual([]);
    // Now go silent — fires after the full idleMs from the last chunk.
    vi.advanceTimersByTime(999);
    expect(kills).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(kills).toEqual(['SIGTERM']);
  });

  it('stderr also resets the idle timer (warnings count as activity)', () => {
    const { child, kills, emitStderr } = makeFakeChild();
    installIdleWatchdog(child, { idleMs: 1000 });
    vi.advanceTimersByTime(800);
    emitStderr('deprecation warning');
    vi.advanceTimersByTime(800);
    expect(kills).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(kills).toEqual(['SIGTERM']);
  });

  it('abortSignal triggers the same SIGTERM → SIGKILL ladder', () => {
    const { child, kills } = makeFakeChild();
    const controller = new AbortController();
    installIdleWatchdog(child, { idleMs: 1000, graceMs: 100, abortSignal: controller.signal });
    controller.abort();
    expect(kills).toEqual(['SIGTERM']);
    vi.advanceTimersByTime(100);
    expect(kills).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('abort does NOT fire onIdle (onIdle is reserved for the idle path only)', () => {
    const { child } = makeFakeChild();
    const onIdle = vi.fn();
    const controller = new AbortController();
    installIdleWatchdog(child, { idleMs: 1000, abortSignal: controller.signal, onIdle });
    controller.abort();
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('stop() clears the timer so the child is not killed after a clean exit', () => {
    const { child, kills } = makeFakeChild();
    const wd = installIdleWatchdog(child, { idleMs: 1000 });
    vi.advanceTimersByTime(500);
    wd.stop();
    vi.advanceTimersByTime(10_000);
    expect(kills).toEqual([]);
  });

  it('stop() is idempotent', () => {
    const { child } = makeFakeChild();
    const wd = installIdleWatchdog(child, { idleMs: 1000 });
    expect(() => {
      wd.stop();
      wd.stop();
      wd.stop();
    }).not.toThrow();
  });

  it('SIGKILL escalation does not fire after stop() (post-success grace cancellation)', () => {
    const { child, kills } = makeFakeChild();
    const wd = installIdleWatchdog(child, { idleMs: 1000, graceMs: 500 });
    vi.advanceTimersByTime(1000); // SIGTERM fired
    wd.stop(); // clean exit before grace elapses
    vi.advanceTimersByTime(10_000);
    expect(kills).toEqual(['SIGTERM']);
  });

  it('survives a child that already exited (kill throws ESRCH-style; swallowed)', () => {
    const { child, kills } = makeFakeChild();
    Object.assign(child, {
      kill: (sig: NodeJS.Signals): boolean => {
        kills.push(String(sig));
        throw new Error('ESRCH: no such process');
      },
    });
    installIdleWatchdog(child, { idleMs: 1000, graceMs: 100 });
    expect(() => vi.advanceTimersByTime(1100)).not.toThrow();
    // Both kill calls were attempted even though they threw.
    expect(kills).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('exposes a sensible DEFAULT_IDLE_MS (5 min)', () => {
    expect(DEFAULT_IDLE_MS).toBe(5 * 60 * 1000);
  });

  it('removes the abort listener on stop() so a reused AbortController does not collect dead handlers', () => {
    // A single AbortController is reused across many spawns in a session. Each successful
    // spawn must release its abort listener in stop(), otherwise the signal accumulates dead
    // handlers that never fire and keep the watchdog closures (and child refs) alive.
    //
    // We instrument the AbortSignal's add/remove to capture the listener registered by the
    // watchdog and assert removeEventListener fires on stop() with the SAME function ref.
    const { child } = makeFakeChild();
    const controller = new AbortController();
    const signal = controller.signal;
    const adds: EventListener[] = [];
    const removes: EventListener[] = [];
    const origAdd = signal.addEventListener.bind(signal);
    const origRemove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
      if (type === 'abort' && typeof listener === 'function') adds.push(listener);
      origAdd(type, listener, options);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((type: string, listener: EventListener, options?: EventListenerOptions) => {
      if (type === 'abort' && typeof listener === 'function') removes.push(listener);
      origRemove(type, listener, options);
    }) as typeof signal.removeEventListener;

    const w = installIdleWatchdog(child, { idleMs: 1000, abortSignal: signal });
    expect(adds).toHaveLength(1);

    w.stop();
    expect(removes).toHaveLength(1);
    expect(removes[0]).toBe(adds[0]);
  });
});
