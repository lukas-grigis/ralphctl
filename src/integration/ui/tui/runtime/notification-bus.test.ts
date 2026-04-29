/**
 * Tests for the in-memory notification bus.
 *
 * Two behaviours matter:
 *   - replace-on-new — a second `show()` overwrites the first regardless of
 *     id; the previous notification's slot is lost (single-slot stacking).
 *   - subscribe semantics — listeners receive the current value on attach,
 *     each transition, and stop receiving after `unsubscribe()`.
 */

import { describe, expect, it, vi } from 'vitest';
import { InMemoryNotificationBus, type Notification } from './notification-bus.ts';

function makeNotification(id: string, message = `notif ${id}`): Notification {
  return { id, message, status: 'info' };
}

describe('InMemoryNotificationBus', () => {
  describe('replace-on-new', () => {
    it('show() replaces an existing notification immediately', () => {
      const bus = new InMemoryNotificationBus();
      const a = makeNotification('a');
      const b = makeNotification('b');

      bus.show(a);
      expect(bus.current()).toBe(a);

      bus.show(b);
      expect(bus.current()).toBe(b);
    });

    it('clear(id) is a no-op when the active id does not match', () => {
      const bus = new InMemoryNotificationBus();
      const a = makeNotification('a');
      bus.show(a);

      bus.clear('something-else');
      expect(bus.current()).toBe(a);
    });

    it('clear(id) drops the active notification when the id matches', () => {
      const bus = new InMemoryNotificationBus();
      const a = makeNotification('a');
      bus.show(a);

      bus.clear('a');
      expect(bus.current()).toBeNull();
    });
  });

  describe('subscribe', () => {
    it('invokes the listener with the current value on attach', () => {
      const bus = new InMemoryNotificationBus();
      const a = makeNotification('a');
      bus.show(a);

      const listener = vi.fn();
      bus.subscribe(listener);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(a);
    });

    it('invokes the listener with null when no notification is active on attach', () => {
      const bus = new InMemoryNotificationBus();
      const listener = vi.fn();
      bus.subscribe(listener);
      expect(listener).toHaveBeenCalledWith(null);
    });

    it('notifies subscribers on show() and clear()', () => {
      const bus = new InMemoryNotificationBus();
      const listener = vi.fn();
      bus.subscribe(listener);
      listener.mockClear();

      const a = makeNotification('a');
      bus.show(a);
      expect(listener).toHaveBeenCalledWith(a);

      const b = makeNotification('b');
      bus.show(b);
      expect(listener).toHaveBeenCalledWith(b);

      bus.clear('b');
      expect(listener).toHaveBeenLastCalledWith(null);
    });

    it('unsubscribe removes the listener so it no longer receives updates', () => {
      const bus = new InMemoryNotificationBus();
      const listener = vi.fn();
      const unsubscribe = bus.subscribe(listener);
      listener.mockClear();

      unsubscribe();
      bus.show(makeNotification('a'));
      expect(listener).not.toHaveBeenCalled();
    });

    it('a listener throwing does not stall delivery to other listeners', () => {
      const bus = new InMemoryNotificationBus();
      const noisy = vi.fn(() => {
        throw new Error('listener boom');
      });
      const quiet = vi.fn();
      bus.subscribe(noisy);
      bus.subscribe(quiet);
      noisy.mockClear();
      quiet.mockClear();

      const a = makeNotification('a');
      bus.show(a);

      expect(noisy).toHaveBeenCalledWith(a);
      expect(quiet).toHaveBeenCalledWith(a);
    });
  });
});
