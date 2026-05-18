import { describe, expect, it } from 'vitest';
import { createLogLevelGate, passesLogLevel } from '@src/business/observability/log-level-filter.ts';

describe('passesLogLevel', () => {
  // Truth table: rows = event level, columns = floor.
  // `true` means the event passes; `false` means it is dropped.
  const cases: ReadonlyArray<{
    readonly event: 'debug' | 'info' | 'warn' | 'error';
    readonly floor: 'silent' | 'debug' | 'info' | 'warn' | 'error';
    readonly expected: boolean;
  }> = [
    // floor=silent — everything dropped
    { event: 'debug', floor: 'silent', expected: false },
    { event: 'info', floor: 'silent', expected: false },
    { event: 'warn', floor: 'silent', expected: false },
    { event: 'error', floor: 'silent', expected: false },
    // floor=error — only error passes
    { event: 'debug', floor: 'error', expected: false },
    { event: 'info', floor: 'error', expected: false },
    { event: 'warn', floor: 'error', expected: false },
    { event: 'error', floor: 'error', expected: true },
    // floor=warn — warn + error pass
    { event: 'debug', floor: 'warn', expected: false },
    { event: 'info', floor: 'warn', expected: false },
    { event: 'warn', floor: 'warn', expected: true },
    { event: 'error', floor: 'warn', expected: true },
    // floor=info — info, warn, error pass; debug dropped
    { event: 'debug', floor: 'info', expected: false },
    { event: 'info', floor: 'info', expected: true },
    { event: 'warn', floor: 'info', expected: true },
    { event: 'error', floor: 'info', expected: true },
    // floor=debug — everything passes
    { event: 'debug', floor: 'debug', expected: true },
    { event: 'info', floor: 'debug', expected: true },
    { event: 'warn', floor: 'debug', expected: true },
    { event: 'error', floor: 'debug', expected: true },
  ];

  for (const { event, floor, expected } of cases) {
    it(`event=${event} floor=${floor} -> ${String(expected)}`, () => {
      expect(passesLogLevel(event, floor)).toBe(expected);
    });
  }
});

describe('createLogLevelGate', () => {
  it('starts at the initial level and reflects writes through get()', () => {
    const gate = createLogLevelGate('info');
    expect(gate.get()).toBe('info');
    gate.set('debug');
    expect(gate.get()).toBe('debug');
    gate.set('silent');
    expect(gate.get()).toBe('silent');
  });

  it('feeds passesLogLevel — flipping the floor changes the verdict mid-stream', () => {
    const gate = createLogLevelGate('info');
    expect(passesLogLevel('debug', gate.get())).toBe(false);
    gate.set('debug');
    expect(passesLogLevel('debug', gate.get())).toBe(true);
    gate.set('silent');
    expect(passesLogLevel('error', gate.get())).toBe(false);
  });
});
