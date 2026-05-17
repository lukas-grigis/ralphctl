import { describe, expect, it } from 'vitest';
import { createInMemorySink } from '@tests/fixtures/in-memory-sink.ts';

describe('createInMemorySink', () => {
  it('starts with an empty buffer', () => {
    const sink = createInMemorySink<number>();
    expect(sink.entries).toEqual([]);
  });

  it('records every value emitted, in order', () => {
    const sink = createInMemorySink<number>();
    sink.emit(1);
    sink.emit(2);
    sink.emit(3);
    expect(sink.entries).toEqual([1, 2, 3]);
  });

  it('clear() empties the buffer; subsequent emits start fresh', () => {
    const sink = createInMemorySink<string>();
    sink.emit('a');
    sink.emit('b');
    sink.clear();
    expect(sink.entries).toEqual([]);
    sink.emit('c');
    expect(sink.entries).toEqual(['c']);
  });

  it('exposes the buffer as a live snapshot — subsequent emits are visible to the same reference', () => {
    const sink = createInMemorySink<number>();
    const view = sink.entries;
    sink.emit(1);
    sink.emit(2);
    // The getter returns the same array reference each time; readers should re-read.
    expect(sink.entries).toEqual([1, 2]);
    expect(view).toEqual([1, 2]);
  });

  it('is generic over the value type — works for arbitrary objects', () => {
    interface Event {
      readonly kind: string;
      readonly count: number;
    }
    const sink = createInMemorySink<Event>();
    sink.emit({ kind: 'tick', count: 1 });
    sink.emit({ kind: 'tick', count: 2 });
    expect(sink.entries.map((e) => e.count)).toEqual([1, 2]);
  });
});
