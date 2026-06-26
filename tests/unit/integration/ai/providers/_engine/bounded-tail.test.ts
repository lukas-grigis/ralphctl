/**
 * Verify the rolling tail accumulator used to cap child stderr across the headless adapters:
 *  - retains everything while under the cap,
 *  - keeps only the LAST `capBytes` characters once it overflows (tail, not head),
 *  - survives a single oversized append by trimming immediately after.
 */

import { describe, expect, it } from 'vitest';
import { STDERR_TAIL_CAP, createBoundedTail } from '@src/integration/ai/providers/_engine/bounded-tail.ts';

describe('createBoundedTail', () => {
  it('retains the full content while under the cap', () => {
    const tail = createBoundedTail(10);
    tail.append('abc');
    tail.append('de');
    expect(tail.value()).toBe('abcde');
  });

  it('keeps only the last capBytes characters once it overflows', () => {
    const tail = createBoundedTail(5);
    tail.append('abcdefg'); // 7 chars into a 5-cap
    expect(tail.value()).toBe('cdefg');

    tail.append('hij'); // rolling window advances
    expect(tail.value()).toBe('fghij');
  });

  it('trims a single oversized append back to the cap', () => {
    const tail = createBoundedTail(4);
    tail.append('0123456789');
    expect(tail.value()).toBe('6789');
    expect(tail.value().length).toBe(4);
  });

  it('exposes a non-trivial default stderr cap', () => {
    expect(STDERR_TAIL_CAP).toBeGreaterThanOrEqual(8192);
  });
});
