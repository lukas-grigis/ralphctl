import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { AbortError } from '@src/domain/value/error/abort-error.ts';

/**
 * `waitForShutdown` is the containment boundary for fatal Ink errors. A plain quit RESOLVES
 * `waitUntilExit()`; a fatal `exit(err)` / uncaught render error REJECTS it. The old blanket
 * `catch {}` swallowed every rejection as a clean shutdown — masking crashes as exit 0. These
 * tests pin: clean quit → resolves, exit code untouched; fatal → stderr + exit 1; AbortError →
 * re-thrown untouched.
 */
const mockInstance = {
  waitUntilExit: vi.fn(),
  unmount: vi.fn(),
  clear: vi.fn(),
  rerender: vi.fn(),
  cleanup: vi.fn(),
};

/**
 * Ordering log shared by the `ink` and `stdin-handoff` mocks. `vi.hoisted` so it exists by the
 * time the hoisted mock factories close over it.
 */
const { order, releaseStdinForChild, restoreStdin } = vi.hoisted(() => {
  const log: string[] = [];
  const restore = vi.fn(() => {
    log.push('restore');
  });
  const release = vi.fn(async () => {
    log.push('release');
    return restore;
  });
  return { order: log, releaseStdinForChild: release, restoreStdin: restore };
});

vi.mock('@src/application/ui/shared/stdin-handoff.ts', () => ({
  releaseStdinForChild,
}));

vi.mock('ink', () => ({
  render: vi.fn(() => {
    order.push('render');
    return mockInstance;
  }),
}));

const { createInkHost } = await import('@src/application/ui/shared/ink-host.ts');

describe('createInkHost waitForShutdown', () => {
  const originalExitCode = process.exitCode;
  let stderr: string;

  beforeEach(() => {
    stderr = '';
    mockInstance.waitUntilExit.mockReset();
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr += typeof chunk === 'string' ? chunk : String(chunk);
      return true;
    });
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = originalExitCode;
  });

  const makeHost = () => createInkHost({ renderElement: () => React.createElement(React.Fragment) });

  it('resolves cleanly on a normal quit and leaves the exit code untouched', async () => {
    mockInstance.waitUntilExit.mockResolvedValueOnce(undefined);
    const host = makeHost();

    await expect(host.waitForShutdown()).resolves.toBeUndefined();
    expect(process.exitCode).toBeUndefined();
    expect(stderr).toBe('');
  });

  it('surfaces a fatal render error with a stderr message and exit code 1', async () => {
    mockInstance.waitUntilExit.mockRejectedValueOnce(new Error('Raw mode is not supported'));
    const host = makeHost();

    await host.waitForShutdown();

    expect(process.exitCode).toBe(1);
    expect(stderr).toContain('the TUI exited with an error');
    expect(stderr).toContain('Raw mode is not supported');
  });

  it('re-throws an AbortError untouched (must propagate)', async () => {
    mockInstance.waitUntilExit.mockRejectedValueOnce(new AbortError({ elementName: 'tui' }));
    const host = makeHost();

    await expect(host.waitForShutdown()).rejects.toBeInstanceOf(AbortError);
    expect(process.exitCode).toBeUndefined();
  });
});

/**
 * The host must rebuild the App element on every pause/resume — not replay a frozen element — so
 * the remounted tree picks up live state (e.g. the user's in-session sprint selection). This pins
 * that `renderElement` is invoked again on resume: one `runInTerminal` cycle ⇒ factory called
 * twice (initial mount + resume remount).
 */
describe('createInkHost rebuilds the element on resume', () => {
  beforeEach(() => {
    mockInstance.waitUntilExit.mockReset();
    mockInstance.unmount.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls renderElement again on each runInTerminal resume', async () => {
    // The pause path unmounts the current instance and awaits its exit before running `fn`.
    mockInstance.waitUntilExit.mockResolvedValue(undefined);

    const renderElement = vi.fn(() => React.createElement(React.Fragment));
    const host = createInkHost({ renderElement });

    // Initial mount built one element.
    expect(renderElement).toHaveBeenCalledTimes(1);

    await host.runInTerminal(async () => 'done');

    // Resume remounted a freshly built element rather than reusing the first.
    expect(renderElement).toHaveBeenCalledTimes(2);
  });
});

/**
 * The stdin handoff only works in one order: release AFTER Ink's teardown has finished (so we do
 * not fight its own listener removal), before the child runs, and restore BEFORE the remount so
 * the fresh tree finds the stream as it left it. See `.claude/docs/INTERACTIVE-HANDOFF-HANG.md`.
 */
describe('createInkHost stdin handoff ordering', () => {
  beforeEach(() => {
    order.length = 0;
    releaseStdinForChild.mockClear();
    restoreStdin.mockClear();
    mockInstance.unmount.mockReset();
    mockInstance.unmount.mockImplementation(() => {
      order.push('unmount');
    });
    mockInstance.waitUntilExit.mockReset();
    mockInstance.waitUntilExit.mockImplementation(async () => {
      order.push('wait-exit');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeHost = () => {
    const host = createInkHost({ renderElement: () => React.createElement(React.Fragment) });
    order.length = 0; // Drop the initial mount's `render`.
    return host;
  };

  it('releases stdin after the unmount completes and restores it before the remount', async () => {
    const host = makeHost();

    await host.runInTerminal(async () => {
      order.push('fn');
      return 'done';
    });

    expect(order).toEqual(['unmount', 'wait-exit', 'release', 'fn', 'restore', 'render']);
    expect(releaseStdinForChild).toHaveBeenCalledTimes(1);
  });

  it('restores stdin before remounting even when fn throws', async () => {
    const host = makeHost();

    await expect(
      host.runInTerminal(async () => {
        order.push('fn');
        throw new Error('session failed');
      })
    ).rejects.toThrow('session failed');

    expect(order).toEqual(['unmount', 'wait-exit', 'release', 'fn', 'restore', 'render']);
  });
});
