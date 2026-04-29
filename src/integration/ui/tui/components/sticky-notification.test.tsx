/**
 * StickyNotification tests — verify the contract every sticky toast obeys.
 *
 *   - 10s auto-dismiss timer
 *   - Esc dismisses without firing the action
 *   - action success → onDismiss
 *   - action failure → notification stays + inline error renders
 *   - replace-on-new (key change) unbinds the prior shortcut and rebinds the new one
 *   - both hints render simultaneously when an action is bound
 *   - informational notification (no action) shows only the dismiss hint
 *
 * We use fake timers for the auto-dismiss case so the test runs in <10s and
 * the timer fire is deterministic.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { STICKY_NOTIFICATION_TIMEOUT_MS, StickyNotification } from './sticky-notification.tsx';
import type { Notification } from '@src/integration/ui/tui/runtime/notification-bus.ts';

function noop(): void {
  // Intentionally empty — used as a stable onDismiss when the test only cares
  // about render output, not dismiss-time behaviour.
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function flushEscape(): Promise<void> {
  // Ink defers single-byte ESC by ~20ms to disambiguate it from the start of
  // an escape sequence. Waiting a touch longer flushes the escape.
  await new Promise((resolve) => setTimeout(resolve, 40));
  await flush();
}

describe('StickyNotification', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders both action and dismiss hints when an action is bound', () => {
    const notification: Notification = {
      id: 'a',
      message: 'sprint completed',
      status: 'success',
      action: {
        key: 'x',
        label: 'the runs list',
        run: async () => Promise.resolve({ ok: true }),
      },
    };
    const { lastFrame } = render(<StickyNotification notification={notification} onDismiss={noop} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('press');
    expect(frame).toContain('x');
    expect(frame).toContain('the runs list');
    expect(frame).toContain('esc to dismiss');
  });

  it('renders only the dismiss hint for an informational notification with no action', () => {
    const notification: Notification = {
      id: 'a',
      message: 'heads up',
      status: 'info',
    };
    const { lastFrame } = render(<StickyNotification notification={notification} onDismiss={noop} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('esc to dismiss');
    expect(frame).not.toContain('press');
  });

  it('Esc dismisses without firing the action', async () => {
    const run = vi.fn(() => Promise.resolve({ ok: true as const }));
    const onDismiss = vi.fn();
    const notification: Notification = {
      id: 'a',
      message: 'm',
      status: 'success',
      action: { key: 'x', label: 'list', run },
    };
    const { stdin } = render(<StickyNotification notification={notification} onDismiss={onDismiss} />);
    await flush();

    stdin.write(''); // Esc
    await flushEscape();

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith('a');
    expect(run).not.toHaveBeenCalled();
  });

  it('clears via onDismiss when the action returns ok', async () => {
    const run = vi.fn(() => Promise.resolve({ ok: true as const }));
    const onDismiss = vi.fn();
    const notification: Notification = {
      id: 'a',
      message: 'm',
      status: 'success',
      action: { key: 'x', label: 'list', run },
    };
    const { stdin } = render(<StickyNotification notification={notification} onDismiss={onDismiss} />);
    await flush();

    stdin.write('x');
    await flush();
    // run() resolves on the next microtask; let React commit the post-resolve
    // setState before asserting.
    await flush();

    expect(run).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith('a');
  });

  it('keeps the notification visible and shows an inline error when the action fails', async () => {
    const run = vi.fn(() => Promise.resolve({ ok: false as const, error: 'boom' }));
    const onDismiss = vi.fn();
    const notification: Notification = {
      id: 'a',
      message: 'm',
      status: 'success',
      action: { key: 'x', label: 'list', run },
    };
    const { stdin, lastFrame } = render(<StickyNotification notification={notification} onDismiss={onDismiss} />);
    await flush();

    stdin.write('x');
    await flush();
    await flush();

    expect(run).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('m');
    expect(frame).toContain('boom');
  });

  it('auto-dismisses after the configured timeout', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const captured: { fn: () => void; ms: number }[] = [];
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms = 0) => {
      // Capture the auto-dismiss timer specifically — it is the only
      // setTimeout in this component scheduled at exactly the configured
      // timeout. Other timers (Ink/React internals) keep their real behaviour.
      if (ms === STICKY_NOTIFICATION_TIMEOUT_MS) {
        captured.push({ fn, ms });
        // Return a fake handle Ink/React won't try to use directly.
        return { __captured: true } as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(fn, ms);
    }) as typeof setTimeout);
    const clearTimeoutSpy = vi
      .spyOn(globalThis, 'clearTimeout')
      .mockImplementation((handle: Parameters<typeof clearTimeout>[0]) => {
        const candidate = handle as unknown;
        if (typeof candidate === 'object' && candidate !== null && '__captured' in candidate) {
          return;
        }
        realClearTimeout(handle);
      });

    try {
      const onDismiss = vi.fn();
      const notification: Notification = {
        id: 'a',
        message: 'm',
        status: 'info',
      };
      render(<StickyNotification notification={notification} onDismiss={onDismiss} />);
      await flush();

      expect(captured.length).toBeGreaterThanOrEqual(1);
      const last = captured[captured.length - 1];
      expect(last?.ms).toBe(STICKY_NOTIFICATION_TIMEOUT_MS);
      expect(onDismiss).not.toHaveBeenCalled();

      // Fire the auto-dismiss timer manually. The component dismisses on the
      // exact configured timeout, no sooner.
      last?.fn();

      expect(onDismiss).toHaveBeenCalledTimes(1);
      expect(onDismiss).toHaveBeenCalledWith('a');
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it('replace-on-new unbinds the prior action key and binds the new one', async () => {
    const runA = vi.fn(() => Promise.resolve({ ok: true as const }));
    const runB = vi.fn(() => Promise.resolve({ ok: true as const }));
    const onDismiss = vi.fn();
    const a: Notification = {
      id: 'a',
      message: 'A',
      status: 'success',
      action: { key: 'x', label: 'A list', run: runA },
    };
    const b: Notification = {
      id: 'b',
      message: 'B',
      status: 'success',
      action: { key: 'y', label: 'B list', run: runB },
    };

    const { stdin, rerender } = render(<StickyNotification key={a.id} notification={a} onDismiss={onDismiss} />);
    await flush();

    // Replace via key change — React unmounts the prior and mounts the new
    // one, dropping the prior input handler.
    rerender(<StickyNotification key={b.id} notification={b} onDismiss={onDismiss} />);
    await flush();

    // Pressing the prior action key after replacement does nothing.
    stdin.write('x');
    await flush();
    await flush();
    expect(runA).not.toHaveBeenCalled();

    // Pressing the new action key fires the new action.
    stdin.write('y');
    await flush();
    await flush();
    expect(runB).toHaveBeenCalledTimes(1);
  });
});
