import { describe, expect, it, vi } from 'vitest';

import { IsoTimestamp } from '../../domain/values/iso-timestamp.ts';
import { InMemoryLogEventBus, type LogEvent } from './log-event-bus.ts';

const NOW = IsoTimestamp.trustString('2026-04-29T00:00:00.000Z');

function evt(message: string): LogEvent {
  return { level: 'info', message, timestamp: NOW, context: {} };
}

describe('InMemoryLogEventBus', () => {
  it('delivers events in emission order to a single subscriber', () => {
    const bus = new InMemoryLogEventBus();
    const seen: string[] = [];
    bus.subscribe((e) => seen.push(e.message));

    bus.emit(evt('a'));
    bus.emit(evt('b'));
    bus.emit(evt('c'));

    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('fans out to multiple subscribers', () => {
    const bus = new InMemoryLogEventBus();
    const a: string[] = [];
    const b: string[] = [];
    bus.subscribe((e) => a.push(e.message));
    bus.subscribe((e) => b.push(e.message));

    bus.emit(evt('x'));
    expect(a).toEqual(['x']);
    expect(b).toEqual(['x']);
  });

  it('isolates throwing listeners', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bus = new InMemoryLogEventBus();
    const ok: string[] = [];
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe((e) => ok.push(e.message));

    bus.emit(evt('y'));
    expect(ok).toEqual(['y']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('unsubscribe stops further delivery', () => {
    const bus = new InMemoryLogEventBus();
    const seen: string[] = [];
    const off = bus.subscribe((e) => seen.push(e.message));
    bus.emit(evt('1'));
    off();
    bus.emit(evt('2'));
    expect(seen).toEqual(['1']);
  });

  it('dispose() drops subscribers and ignores subsequent emissions', () => {
    const bus = new InMemoryLogEventBus();
    const seen: string[] = [];
    bus.subscribe((e) => seen.push(e.message));
    bus.dispose();
    bus.emit(evt('after-dispose'));
    expect(seen).toEqual([]);
  });
});
