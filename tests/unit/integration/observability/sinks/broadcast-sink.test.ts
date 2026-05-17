import { describe, expect, it, vi } from 'vitest';
import type { Sink } from '@src/business/observability/sink.ts';
import { broadcastSink } from '@src/integration/observability/sinks/broadcast-sink.ts';
import { createInMemorySink } from '@tests/fixtures/in-memory-sink.ts';

describe('broadcastSink', () => {
  it('forwards each emitted value to every target in declaration order', () => {
    const a = createInMemorySink<number>();
    const b = createInMemorySink<number>();
    const c = createInMemorySink<number>();

    const broadcast = broadcastSink([a, b, c]);
    broadcast.emit(1);
    broadcast.emit(2);

    expect(a.entries).toEqual([1, 2]);
    expect(b.entries).toEqual([1, 2]);
    expect(c.entries).toEqual([1, 2]);
  });

  it('is a no-op with zero targets', () => {
    const broadcast = broadcastSink<number>([]);
    expect(() => broadcast.emit(1)).not.toThrow();
  });

  it('one target throwing does not stall delivery to the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const captured = createInMemorySink<string>();
    const throwing: Sink<string> = {
      emit() {
        throw new Error('boom');
      },
    };

    const broadcast = broadcastSink<string>([throwing, captured]);
    broadcast.emit('hello');

    expect(captured.entries).toEqual(['hello']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('preserves per-target ordering across multiple emits', () => {
    const a = createInMemorySink<string>();
    const b = createInMemorySink<string>();
    const broadcast = broadcastSink([a, b]);

    for (const value of ['x', 'y', 'z']) broadcast.emit(value);

    expect(a.entries).toEqual(['x', 'y', 'z']);
    expect(b.entries).toEqual(['x', 'y', 'z']);
  });
});
