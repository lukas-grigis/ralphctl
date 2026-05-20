import { describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '@src/business/observability/events.ts';
import type { NotificationDispatcher } from '@src/business/observability/notification-dispatcher.ts';
import {
  classifyEventForNotification,
  startNotificationSubscriber,
} from '@src/business/observability/notification-subscriber.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { isoTimestamp } from '@tests/fixtures/domain.ts';

const NOW = isoTimestamp('2026-05-20T10:00:00.000Z');

interface RecordedCall {
  readonly level: 'attention' | 'paused' | 'failure';
  readonly title: string;
  readonly body?: string;
}

const buildHarness = (opts: { readonly disabled?: () => boolean } = {}) => {
  const bus = createInMemoryEventBus();
  const calls: RecordedCall[] = [];
  const dispatcher: NotificationDispatcher = {
    async notify(level, title, body) {
      calls.push({ level, title, ...(body !== undefined ? { body } : {}) });
    },
  };
  const unsub = startNotificationSubscriber({
    eventBus: bus,
    dispatcher,
    disabled: opts.disabled ?? ((): boolean => false),
  });
  return { bus, calls, unsub };
};

describe('classifyEventForNotification', () => {
  it("emits 'failure' on chain-step-failed for the setup-script-runner leaf", () => {
    const event: AppEvent = {
      type: 'chain-step-failed',
      chainId: 'c-1',
      elementName: 'setup-script-runner',
      durationMs: 12,
      error: new InvalidStateError({
        entity: 'sprint',
        currentState: 'pre-implement',
        attemptedAction: 'setup-script',
        message: 'pnpm install: exit 1',
      }),
      at: NOW,
    };
    expect(classifyEventForNotification(event)).toEqual({
      level: 'failure',
      title: 'ralphctl: setup failed',
      body: 'pnpm install: exit 1',
    });
  });

  it('ignores chain-step-failed for non-setup leaves', () => {
    const event: AppEvent = {
      type: 'chain-step-failed',
      chainId: 'c-1',
      elementName: 'evaluator-some-task-id',
      durationMs: 12,
      error: new InvalidStateError({
        entity: 'task',
        currentState: 'in_progress',
        attemptedAction: 'evaluate',
        message: 'malformed signals',
      }),
      at: NOW,
    };
    expect(classifyEventForNotification(event)).toBeUndefined();
  });

  it("emits 'failure' on chain-aborted, carrying the reason as body when present", () => {
    expect(
      classifyEventForNotification({
        type: 'chain-aborted',
        chainId: 'c-1',
        reason: 'SIGTERM',
        at: NOW,
      })
    ).toEqual({ level: 'failure', title: 'ralphctl aborted', body: 'SIGTERM' });
  });

  it("emits 'failure' on chain-aborted with no body when reason is absent", () => {
    expect(
      classifyEventForNotification({
        type: 'chain-aborted',
        chainId: 'c-1',
        at: NOW,
      })
    ).toEqual({ level: 'failure', title: 'ralphctl aborted' });
  });

  it("emits 'paused' for log events whose meta.delayMs is ≥ 60_000", () => {
    expect(
      classifyEventForNotification({
        type: 'log',
        level: 'info',
        message: 'claude-provider: waiting 60000ms before retry',
        meta: { delayMs: 60_000, nextAttempt: 2, maxAttempts: 4 },
        at: NOW,
      })
    ).toEqual({ level: 'paused', title: 'ralphctl paused', body: 'Waiting for rate limit' });
  });

  it('ignores log events with sub-threshold meta.delayMs (< 60_000)', () => {
    expect(
      classifyEventForNotification({
        type: 'log',
        level: 'info',
        message: 'claude-provider: waiting 30000ms before retry',
        meta: { delayMs: 30_000 },
        at: NOW,
      })
    ).toBeUndefined();
  });

  it('ignores log events without a delayMs meta key', () => {
    expect(
      classifyEventForNotification({
        type: 'log',
        level: 'info',
        message: 'unrelated info',
        at: NOW,
      })
    ).toBeUndefined();
  });

  it("emits 'attention' for warn-level log events containing 'baseline already red'", () => {
    const decision = classifyEventForNotification({
      type: 'log',
      level: 'warn',
      message: 'pre-task-check /repos/app: baseline already red (exit=1) — task will start on broken baseline',
      at: NOW,
    });
    expect(decision?.level).toBe('attention');
    expect(decision?.title).toBe('Pre-check red');
    // Body should contain the path-shaped hint extracted from the message.
    expect(decision?.body).toContain('/repos/app');
  });

  it("ignores info-level log events that mention 'baseline already red'", () => {
    // Defensive — only warn-level entries surface as attention; info noise stays muted.
    expect(
      classifyEventForNotification({
        type: 'log',
        level: 'info',
        message: 'baseline already red (debug noise)',
        at: NOW,
      })
    ).toBeUndefined();
  });

  it('ignores unrelated event types (chain-started, chain-completed, memory-pressure, etc.)', () => {
    expect(
      classifyEventForNotification({ type: 'chain-started', chainId: 'c-1', flowId: 'implement', at: NOW })
    ).toBeUndefined();
    expect(classifyEventForNotification({ type: 'chain-completed', chainId: 'c-1', at: NOW })).toBeUndefined();
    expect(
      classifyEventForNotification({
        type: 'memory-pressure',
        severity: 'warning',
        ratio: 0.85,
        heapUsed: 1,
        heapLimit: 2,
        at: NOW,
      })
    ).toBeUndefined();
  });
});

describe('startNotificationSubscriber', () => {
  it('routes a matching event through the dispatcher', async () => {
    const h = buildHarness();
    h.bus.publish({
      type: 'chain-aborted',
      chainId: 'c-1',
      reason: 'SIGTERM',
      at: NOW,
    });
    // Dispatch is fire-and-forget; flush microtasks before asserting.
    await Promise.resolve();
    expect(h.calls).toEqual([{ level: 'failure', title: 'ralphctl aborted', body: 'SIGTERM' }]);
    h.unsub();
  });

  it('disable gate suppresses every dispatcher call without unsubscribing', async () => {
    const h = buildHarness({ disabled: (): boolean => true });
    h.bus.publish({ type: 'chain-aborted', chainId: 'c-1', reason: 'SIGTERM', at: NOW });
    h.bus.publish({
      type: 'log',
      level: 'info',
      message: 'pause',
      meta: { delayMs: 60_000 },
      at: NOW,
    });
    await Promise.resolve();
    expect(h.calls).toEqual([]);
    h.unsub();
  });

  it('disable gate is read on every event — flipping it mid-stream changes behaviour', async () => {
    let off = true;
    const h = (() => {
      const bus = createInMemoryEventBus();
      const calls: RecordedCall[] = [];
      const dispatcher: NotificationDispatcher = {
        async notify(level, title, body) {
          calls.push({ level, title, ...(body !== undefined ? { body } : {}) });
        },
      };
      const unsub = startNotificationSubscriber({ eventBus: bus, dispatcher, disabled: (): boolean => off });
      return { bus, calls, unsub };
    })();

    h.bus.publish({ type: 'chain-aborted', chainId: 'c-1', reason: 'first', at: NOW });
    await Promise.resolve();
    expect(h.calls).toHaveLength(0);

    off = false;
    h.bus.publish({ type: 'chain-aborted', chainId: 'c-1', reason: 'second', at: NOW });
    await Promise.resolve();
    expect(h.calls).toEqual([{ level: 'failure', title: 'ralphctl aborted', body: 'second' }]);
    h.unsub();
  });

  it('unsub() detaches the listener — subsequent events do not dispatch', async () => {
    const h = buildHarness();
    h.unsub();
    h.bus.publish({ type: 'chain-aborted', chainId: 'c-1', reason: 'SIGTERM', at: NOW });
    await Promise.resolve();
    expect(h.calls).toEqual([]);
  });

  it('a thrown dispatcher does not stall other bus subscribers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bus = createInMemoryEventBus();
    const dispatcher: NotificationDispatcher = {
      async notify() {
        throw new Error('dispatcher exploded');
      },
    };
    startNotificationSubscriber({ eventBus: bus, dispatcher, disabled: (): boolean => false });
    const otherSeen: AppEvent[] = [];
    bus.subscribe((e) => otherSeen.push(e));
    const aborted: AppEvent = { type: 'chain-aborted', chainId: 'c-1', reason: 'oops', at: NOW };
    bus.publish(aborted);
    await Promise.resolve();
    expect(otherSeen).toEqual([aborted]);
    warn.mockRestore();
  });
});
