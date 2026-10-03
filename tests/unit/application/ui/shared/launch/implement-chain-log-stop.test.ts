/**
 * `launchImplement` constructs the events.ndjson sink (bus-subscribed from construction) before the runner exists, so
 * every pre-runner exit must stop it — otherwise later bus events from unrelated runs tee into this sprint's log.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { launchImplement } from '@src/application/ui/shared/launch/implement.ts';
import { resolveImplementAgentBindings } from '@src/application/ui/shared/launch/implement-agent-bindings.ts';
import type { LaunchContext } from '@src/application/ui/shared/launch/context.ts';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { absolutePath, makeActiveSprint, makeProject, makeTodoTask } from '@tests/fixtures/domain.ts';

vi.mock('@src/application/ui/shared/launch/implement-agent-bindings.ts', () => ({
  resolveImplementAgentBindings: vi.fn(),
}));

const makeCtx = (chainLog: { stop: () => void; flush: () => Promise<void> }): LaunchContext => {
  const snapshot = {
    sprint: makeActiveSprint(),
    project: makeProject(),
    tasks: [makeTodoTask({ name: 'only task' })],
  } as unknown as AppStateSnapshot;
  return {
    deps: {
      app: {
        // A wired spawn seam skips the PATH pre-flight, so the launch reaches the sink construction.
        providerSpawn: vi.fn(),
        eventBus: createInMemoryEventBus(),
        logger: noopLogger,
        sprintExecutionRepo: {
          findById: async () => Result.error(new NotFoundError({ entity: 'execution', id: 'none' })),
        },
        chainLogSink: vi.fn(() => chainLog),
      },
      storage: { dataRoot: absolutePath('/tmp/ralphctl-chain-log-stop-test/data') },
    },
    snapshot,
    extras: {},
    settings: DEFAULT_SETTINGS,
    sessionId: () => 'session-1',
    bridge: (runner: unknown) => runner,
  } as unknown as LaunchContext;
};

describe('launchImplement chain-log sink', () => {
  beforeEach(() => {
    vi.mocked(resolveImplementAgentBindings).mockReset();
  });

  it('stops and flushes the sink when provider/element construction throws before the runner exists', async () => {
    const chainLog = { stop: vi.fn(), flush: vi.fn(async () => undefined) };
    vi.mocked(resolveImplementAgentBindings).mockRejectedValue(new Error('boom'));

    await expect(launchImplement(makeCtx(chainLog))).rejects.toThrow('boom');
    expect(chainLog.stop).toHaveBeenCalledTimes(1);
    expect(chainLog.flush).toHaveBeenCalledTimes(1);
  });

  it('rethrows an AbortError unchanged after stopping the sink', async () => {
    const chainLog = { stop: vi.fn(), flush: vi.fn(async () => undefined) };
    const abort = new AbortError({ elementName: 'implement-launch', reason: 'user pressed Ctrl+C' });
    vi.mocked(resolveImplementAgentBindings).mockRejectedValue(abort);

    await expect(launchImplement(makeCtx(chainLog))).rejects.toBe(abort);
    expect(chainLog.stop).toHaveBeenCalledTimes(1);
  });
});
