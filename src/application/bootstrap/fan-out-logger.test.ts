import { describe, expect, it } from 'vitest';

import { FakeLoggerPort } from '../../business/_test-fakes/fake-logger-port.ts';
import type { LoggerPort } from '../../business/ports/logger-port.ts';
import { FanOutLogger } from './fan-out-logger.ts';

describe('FanOutLogger', () => {
  it('forwards every log call to every sink', () => {
    const a = new FakeLoggerPort();
    const b = new FakeLoggerPort();
    const fan = new FanOutLogger([a, b]);
    fan.info('hello', { k: 1 });
    fan.warn('careful');
    fan.error('boom');
    fan.debug('trace');
    expect(a.entries).toHaveLength(4);
    expect(b.entries).toHaveLength(4);
    expect(a.entries[0]?.message).toBe('hello');
    expect(b.entries[3]?.level).toBe('debug');
  });

  it('continues delivering when a sink throws', () => {
    const broken: LoggerPort = {
      log: () => {
        throw new Error('boom');
      },
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      child: () => broken,
      time: () => () => undefined,
    };
    const ok = new FakeLoggerPort();
    const fan = new FanOutLogger([broken, ok]);
    fan.info('still here');
    expect(ok.entries).toHaveLength(1);
  });

  it('child returns a FanOutLogger that bound context flows through', () => {
    const a = new FakeLoggerPort();
    const fan = new FanOutLogger([a]);
    const child = fan.child({ scope: 'unit' });
    child.info('hi');
    expect(a.entries[0]?.context).toEqual({ scope: 'unit' });
  });

  it('time returns a stop-fn that emits a debug record', () => {
    const a = new FakeLoggerPort();
    const fan = new FanOutLogger([a]);
    const stop = fan.time('phase');
    stop();
    expect(a.entries).toHaveLength(1);
    expect(a.entries[0]?.level).toBe('debug');
    expect(a.entries[0]?.message).toBe('phase');
  });
});
