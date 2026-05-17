import { describe, expect, it } from 'vitest';
import { nullSink } from '@src/integration/observability/sinks/null-sink.ts';

describe('nullSink', () => {
  it('drops every emitted value silently', () => {
    const sink = nullSink<number>();
    expect(() => {
      sink.emit(1);
      sink.emit(2);
      sink.emit(3);
    }).not.toThrow();
  });

  it('is generic over the value type', () => {
    const stringSink = nullSink<string>();
    const objSink = nullSink<{ count: number }>();
    expect(() => {
      stringSink.emit('hi');
      objSink.emit({ count: 1 });
    }).not.toThrow();
  });
});
