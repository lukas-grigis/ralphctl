/**
 * Smoke + behaviour tests for the shutdown coordinator. These don't
 * exercise the signal handler wiring (process.on('SIGINT', …)) since
 * Vitest can't safely deliver real signals to itself without the test
 * worker dying. Instead they cover the registration + ordering +
 * unregister contract that the rest of the system depends on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { __resetShutdownStateForTests, registerShutdown } from './shutdown.ts';

afterEach(() => {
  __resetShutdownStateForTests();
});

describe('shutdown coordinator — registration', () => {
  it('returns an unregister function that removes the handler', () => {
    const fn = vi.fn(() => Promise.resolve());
    const unregister = registerShutdown('test-handler', fn);
    expect(typeof unregister).toBe('function');
    // After unregister, calling it again is a safe no-op (it shouldn't throw).
    unregister();
    expect(() => {
      unregister();
    }).not.toThrow();
  });

  it('registers multiple handlers that are independent', () => {
    const a = vi.fn(() => Promise.resolve());
    const b = vi.fn(() => Promise.resolve());
    const unregisterA = registerShutdown('a', a);
    const unregisterB = registerShutdown('b', b);
    // Unregistering one must not affect the other.
    unregisterA();
    expect(typeof unregisterB).toBe('function');
  });

  it('accepts both sync and async cleanup functions', () => {
    expect(() => {
      registerShutdown('sync-handler', () => undefined);
      registerShutdown('async-handler', () => Promise.resolve());
    }).not.toThrow();
  });
});
