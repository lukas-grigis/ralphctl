import { describe, expect, it, vi } from 'vitest';
import type { ExternalPort } from '@src/business/ports/external.ts';
import type { LoggerPort } from '@src/business/ports/logger.ts';
import type { HarnessEvent, SignalBusPort } from '@src/business/ports/signal-bus.ts';
import { recoverDirtyTree } from './recover-dirty-tree.ts';

interface Calls {
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  autoCommit: ReturnType<typeof vi.fn>;
  events: HarnessEvent[];
}

function makeDeps(opts: { hasUncommitted: boolean; autoCommitThrows?: boolean }): {
  deps: { external: ExternalPort; logger: LoggerPort; signalBus: SignalBusPort };
  calls: Calls;
} {
  const warn = vi.fn();
  const error = vi.fn();
  const autoCommit = vi.fn(() =>
    opts.autoCommitThrows ? Promise.reject(new Error('hook rejected')) : Promise.resolve()
  );
  const events: HarnessEvent[] = [];

  const external = {
    hasUncommittedChanges: vi.fn(() => opts.hasUncommitted),
    autoCommit,
  } as unknown as ExternalPort;

  const logger: LoggerPort = {
    debug: () => undefined,
    info: () => undefined,
    warn,
    error,
    success: () => undefined,
    warning: () => undefined,
    tip: () => undefined,
    header: () => undefined,
    separator: () => undefined,
    field: () => undefined,
    card: () => undefined,
    newline: () => undefined,
    dim: () => undefined,
    item: () => undefined,
    spinner: () => ({ succeed: () => undefined, fail: () => undefined, stop: () => undefined }),
    child: () => logger,
    time: () => () => undefined,
  };

  const signalBus: SignalBusPort = {
    emit: (e) => events.push(e),
    subscribe: () => () => undefined,
    dispose: () => undefined,
  };

  return { deps: { external, logger, signalBus }, calls: { warn, error, autoCommit, events } };
}

const params = { sprintId: 's1', taskId: 't1', taskName: 'Task 1', repoPath: '/repo' };

describe('recoverDirtyTree helper', () => {
  it('clean tree: no-op — no commit, no warn, no signal', async () => {
    const { deps, calls } = makeDeps({ hasUncommitted: false });
    await recoverDirtyTree(deps, params);

    expect(calls.autoCommit).not.toHaveBeenCalled();
    expect(calls.warn).not.toHaveBeenCalled();
    expect(calls.error).not.toHaveBeenCalled();
    expect(calls.events).toEqual([]);
  });

  it('dirty tree, auto-commit succeeds: warns, emits note, commits', async () => {
    const { deps, calls } = makeDeps({ hasUncommitted: true });
    await recoverDirtyTree(deps, params);

    expect(calls.warn).toHaveBeenCalledTimes(1);
    const [warnMsg, warnCtx] = calls.warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(warnMsg).toContain('Dirty tree after "Task 1"');
    expect(warnMsg).toContain('auto-committing');
    expect(warnCtx).toEqual({ taskId: 't1', projectPath: '/repo' });

    expect(calls.autoCommit).toHaveBeenCalledTimes(1);
    expect(calls.autoCommit).toHaveBeenCalledWith(
      '/repo',
      'chore(harness): auto-commit leftover changes from "Task 1"'
    );

    expect(calls.events).toHaveLength(1);
    const event = calls.events[0];
    expect(event?.type).toBe('signal');
    if (event?.type !== 'signal') return;
    expect(event.signal.type).toBe('note');
    if (event.signal.type !== 'note') return;
    expect(event.signal.text).toContain('harness auto-commit');
    expect(event.signal.text).toContain('Task 1');
    expect(event.ctx).toEqual({ sprintId: 's1', taskId: 't1', projectPath: '/repo' });

    expect(calls.error).not.toHaveBeenCalled();
  });

  it('dirty tree, auto-commit throws: logs error but does NOT throw (non-blocking)', async () => {
    const { deps, calls } = makeDeps({ hasUncommitted: true, autoCommitThrows: true });

    await expect(recoverDirtyTree(deps, params)).resolves.toBeUndefined();

    expect(calls.warn).toHaveBeenCalledTimes(1);
    expect(calls.autoCommit).toHaveBeenCalledTimes(1);
    expect(calls.error).toHaveBeenCalledTimes(1);
    const [errMsg, errCtx] = calls.error.mock.calls[0] as [string, Record<string, unknown>];
    expect(errMsg).toContain('Auto-commit failed');
    expect(errMsg).toContain('hook rejected');
    expect(errCtx).toEqual({ taskId: 't1', projectPath: '/repo' });

    // Note signal still emitted so the audit trail records the deviation.
    expect(calls.events).toHaveLength(1);
  });
});
