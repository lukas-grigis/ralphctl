import { describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '@src/business/observability/events.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { isoTimestamp } from '@tests/fixtures/domain.ts';

const NOW = isoTimestamp('2026-05-10T10:00:00.000Z');

const logEvent = (message: string): AppEvent => ({
  type: 'log',
  level: 'info',
  message,
  at: NOW,
});

describe('createInMemoryEventBus', () => {
  it('delivers a published event to every active subscriber', () => {
    const bus = createInMemoryEventBus();
    const a: AppEvent[] = [];
    const b: AppEvent[] = [];
    bus.subscribe((e) => a.push(e));
    bus.subscribe((e) => b.push(e));

    bus.publish(logEvent('hello'));

    expect(a).toEqual([logEvent('hello')]);
    expect(b).toEqual([logEvent('hello')]);
  });

  it('does not deliver events published before subscribe (no replay)', () => {
    const bus = createInMemoryEventBus();
    bus.publish(logEvent('first'));

    const collected: AppEvent[] = [];
    bus.subscribe((e) => collected.push(e));
    bus.publish(logEvent('second'));

    expect(collected).toEqual([logEvent('second')]);
  });

  it('stops delivering after unsubscribe', () => {
    const bus = createInMemoryEventBus();
    const collected: AppEvent[] = [];
    const unsubscribe = bus.subscribe((e) => collected.push(e));

    bus.publish(logEvent('first'));
    unsubscribe();
    bus.publish(logEvent('second'));

    expect(collected).toEqual([logEvent('first')]);
  });

  it('isolates a thrown handler so siblings still receive the event', () => {
    const bus = createInMemoryEventBus();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const collected: AppEvent[] = [];

    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe((e) => collected.push(e));

    bus.publish(logEvent('hello'));

    expect(collected).toEqual([logEvent('hello')]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('handles unsubscribe-during-delivery without skipping other subscribers', () => {
    const bus = createInMemoryEventBus();
    const collected: AppEvent[] = [];
    const unsubscribeFirst = bus.subscribe(() => unsubscribeFirst());
    bus.subscribe((e) => collected.push(e));

    bus.publish(logEvent('hello'));

    // The second subscriber still sees the first event because we snapshot
    // the handler set before iterating.
    expect(collected).toEqual([logEvent('hello')]);
  });
});
