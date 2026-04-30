import { describe, expect, it } from 'vitest';

import { MutexQueue } from './mutex-queue.ts';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('MutexQueue', () => {
  it('different keys do not block each other', async () => {
    const m = new MutexQueue<string>();
    const releaseA = await m.acquire('a');
    // Acquiring a different key while 'a' is held must succeed without queuing.
    const releaseB = await m.acquire('b');
    expect(m.size('a')).toBe(1);
    expect(m.size('b')).toBe(1);
    releaseA();
    releaseB();
    expect(m.size('a')).toBe(0);
    expect(m.size('b')).toBe(0);
  });

  it('serializes acquisitions on the same key (holder count never exceeds 1)', async () => {
    const m = new MutexQueue<string>();
    let holders = 0;
    let maxHolders = 0;

    const work = async (): Promise<void> => {
      const release = await m.acquire('shared');
      holders += 1;
      if (holders > maxHolders) maxHolders = holders;
      // Yield a few times so a non-mutex bug would let another caller in.
      await tick();
      await tick();
      holders -= 1;
      release();
    };

    await Promise.all([work(), work(), work(), work(), work()]);
    expect(maxHolders).toBe(1);
    expect(holders).toBe(0);
  });

  it('honors FIFO order under contention', async () => {
    const m = new MutexQueue<string>();
    const order: number[] = [];

    const releaseFirst = await m.acquire('k');

    // Queue three more waiters in order.
    const p1 = m.acquire('k').then((r) => {
      order.push(1);
      r();
    });
    const p2 = m.acquire('k').then((r) => {
      order.push(2);
      r();
    });
    const p3 = m.acquire('k').then((r) => {
      order.push(3);
      r();
    });

    // Release the first holder — queue should drain in FIFO order.
    releaseFirst();
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('abort while waiting cleanly removes that waiter and lets others proceed', async () => {
    const m = new MutexQueue<string>();
    const order: string[] = [];

    const releaseFirst = await m.acquire('k');

    const ac = new AbortController();
    const cancelled = m.acquire('k', ac.signal);

    const okAfter = m.acquire('k').then((r) => {
      order.push('after');
      r();
    });

    // Cancel the middle waiter.
    ac.abort('cancel-me');
    await expect(cancelled).rejects.toBe('cancel-me');

    releaseFirst();
    await okAfter;
    expect(order).toEqual(['after']);
    expect(m.size('k')).toBe(0);
  });

  it('release() is idempotent (calling twice is a no-op)', async () => {
    const m = new MutexQueue<string>();
    const release = await m.acquire('k');
    release();
    release(); // second call must not throw or affect state
    expect(m.size('k')).toBe(0);

    // Subsequent acquire works as expected.
    const release2 = await m.acquire('k');
    expect(m.size('k')).toBe(1);
    release2();
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const m = new MutexQueue<string>();
    const ac = new AbortController();
    ac.abort('preempted');
    await expect(m.acquire('k', ac.signal)).rejects.toBe('preempted');
    expect(m.size('k')).toBe(0);
  });

  it('size() reflects pending + holder', async () => {
    const m = new MutexQueue<string>();
    expect(m.size('k')).toBe(0);
    const r = await m.acquire('k');
    expect(m.size('k')).toBe(1);

    const p1 = m.acquire('k');
    const p2 = m.acquire('k');
    expect(m.size('k')).toBe(3);

    r();
    const r1 = await p1;
    expect(m.size('k')).toBe(2);
    r1();
    const r2 = await p2;
    expect(m.size('k')).toBe(1);
    r2();
    expect(m.size('k')).toBe(0);
  });
});
