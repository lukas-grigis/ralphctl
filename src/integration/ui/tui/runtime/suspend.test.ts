/**
 * Terminal-handoff tests. We stub `screen.ts` so the tests don't fight with
 * the ANSI escape sequences, and we use a fake instance with a spy on
 * `clear()` so we can assert the post-resume redraw.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const enterAltScreenMock = vi.fn();
const exitAltScreenMock = vi.fn();

vi.mock('./screen.ts', () => ({
  enterAltScreen: (): void => {
    enterAltScreenMock();
  },
  exitAltScreen: (): void => {
    exitAltScreenMock();
  },
}));

import { isTuiMounted, registerTuiInstance, withSuspendedTui } from './suspend.ts';

function fakeInstance() {
  return { clear: vi.fn() };
}

describe('withSuspendedTui', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('pass-through when no TUI is mounted — does not touch alt-screen', async () => {
    expect(isTuiMounted()).toBe(false);

    const cb = vi.fn(() => Promise.resolve('result'));
    const value = await withSuspendedTui(cb);

    expect(value).toBe('result');
    expect(cb).toHaveBeenCalledOnce();
    expect(exitAltScreenMock).not.toHaveBeenCalled();
    expect(enterAltScreenMock).not.toHaveBeenCalled();
  });

  it('exits and re-enters alt-screen around the callback when mounted', async () => {
    const instance = fakeInstance();
    const release = registerTuiInstance(instance);
    try {
      const callOrder: string[] = [];
      exitAltScreenMock.mockImplementation(() => callOrder.push('exit'));
      enterAltScreenMock.mockImplementation(() => callOrder.push('enter'));
      instance.clear.mockImplementation(() => callOrder.push('clear'));

      await withSuspendedTui(() => {
        callOrder.push('cb');
      });

      expect(callOrder).toEqual(['exit', 'cb', 'enter', 'clear']);
    } finally {
      release();
    }
  });

  it('returns the callback result when mounted', async () => {
    const instance = fakeInstance();
    const release = registerTuiInstance(instance);
    try {
      const value = await withSuspendedTui(() => 42);
      expect(value).toBe(42);
    } finally {
      release();
    }
  });

  it('re-enters alt-screen even when the callback throws', async () => {
    const instance = fakeInstance();
    const release = registerTuiInstance(instance);
    try {
      await expect(
        withSuspendedTui(() => {
          throw new Error('AI session failed');
        })
      ).rejects.toThrow('AI session failed');

      expect(exitAltScreenMock).toHaveBeenCalledOnce();
      expect(enterAltScreenMock).toHaveBeenCalledOnce();
      expect(instance.clear).toHaveBeenCalledOnce();
    } finally {
      release();
    }
  });

  it('accepts synchronous callbacks', async () => {
    const instance = fakeInstance();
    const release = registerTuiInstance(instance);
    try {
      const value = await withSuspendedTui(() => 'sync');
      expect(value).toBe('sync');
      expect(exitAltScreenMock).toHaveBeenCalledOnce();
      expect(enterAltScreenMock).toHaveBeenCalledOnce();
    } finally {
      release();
    }
  });
});

describe('registerTuiInstance', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('marks the TUI as mounted while the instance is registered', () => {
    expect(isTuiMounted()).toBe(false);
    const release = registerTuiInstance(fakeInstance());
    try {
      expect(isTuiMounted()).toBe(true);
    } finally {
      release();
    }
    expect(isTuiMounted()).toBe(false);
  });

  it('release is idempotent against a later instance — only nulls its own', () => {
    const first = fakeInstance();
    const releaseFirst = registerTuiInstance(first);
    const second = fakeInstance();
    registerTuiInstance(second); // overwrites — legitimate e.g. hot-remount

    // Releasing the first-registered instance should NOT clobber the second.
    releaseFirst();
    expect(isTuiMounted()).toBe(true);
  });
});
