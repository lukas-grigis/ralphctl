import { describe, expect, it } from 'vitest';
import { currentSessionId, runWithSession } from '@src/application/session/session.ts';

describe('session-context', () => {
  it('returns undefined outside any scope', () => {
    expect(currentSessionId()).toBeUndefined();
  });

  it('reads the id inside the scope', async () => {
    const result = await runWithSession('sid-1', async () => currentSessionId());
    expect(result).toBe('sid-1');
  });

  it('threads the id through awaited async work', async () => {
    const inner = async (): Promise<string | undefined> => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      return currentSessionId();
    };
    const result = await runWithSession('sid-2', inner);
    expect(result).toBe('sid-2');
  });

  it('nested scopes shadow the outer id', async () => {
    let outerSeen: string | undefined;
    let innerSeen: string | undefined;
    await runWithSession('outer', async () => {
      outerSeen = currentSessionId();
      await runWithSession('inner', async () => {
        innerSeen = currentSessionId();
      });
      // Outer scope still active here.
      expect(currentSessionId()).toBe('outer');
    });
    expect(outerSeen).toBe('outer');
    expect(innerSeen).toBe('inner');
  });

  // The chain runner's wave scheduler (`wave-scheduler.ts`) launches multiple `runWithSession(...)`
  // calls genuinely CONCURRENTLY — interleaved on the microtask queue via `Promise.race` over an
  // in-flight pool — not merely nested/sequential like the case above. Every downstream
  // `logger.info` / `publishSignal` call inside a branch relies on `currentSessionId()` resolving to
  // THAT branch's id even while sibling branches' async work is interleaved. This pins that
  // guarantee without real timers: each branch yields to the microtask queue several times via
  // `await Promise.resolve()`, so sibling branches' continuations genuinely interleave with it —
  // Node drains the microtask queue in strict FIFO order, so this interleaving is fully
  // deterministic (no reliance on `setTimeout` / OS scheduling / which branch "wins").
  it('resolves each of several CONCURRENTLY interleaved branches to its own id, never a sibling’s', async () => {
    const branchIds = ['branch-a', 'branch-b', 'branch-c', 'branch-d', 'branch-e'] as const;
    const observedBySession = new Map<string, string[]>();

    const interleavingWork = async (sessionId: string): Promise<void> => {
      const observed: string[] = [];
      observedBySession.set(sessionId, observed);
      for (let step = 0; step < 5; step += 1) {
        // Yield to the microtask queue so sibling branches get a chance to run interleaved with
        // this one before it resumes — the exact scenario a shared mutable variable (instead of
        // AsyncLocalStorage) would fail.
        await Promise.resolve();
        observed.push(currentSessionId() ?? 'MISSING');
      }
    };

    await Promise.all(branchIds.map((id) => runWithSession(id, () => interleavingWork(id))));

    // Every branch observed ONLY its own id at every one of its interleaved steps.
    for (const id of branchIds) {
      expect(observedBySession.get(id)).toStrictEqual([id, id, id, id, id]);
    }
    // No leakage into the ambient (non-session) scope once every concurrent branch has settled.
    expect(currentSessionId()).toBeUndefined();
  });

  // Mirrors `wave-scheduler.ts`'s actual concurrency shape (`.claude/docs/HARNESS-PRINCIPLES.md`
  // §7-adjacent parallel-implement machinery): a bounded pool of in-flight branches, `Promise.race`d
  // to admit the next queued branch as soon as a slot frees up. Branches have DIFFERENT lifetimes
  // (varying step counts), so slots turn over unevenly and branches genuinely overlap arbitrarily —
  // not in lockstep like the fixed-size `Promise.all` above. Still fully deterministic: no real
  // timers, only microtask yields and `Promise.race`, whose settlement order Node resolves the same
  // way every run for a given code shape.
  it('keeps every branch on its own id as a bounded `Promise.race` pool (mirroring the wave scheduler) turns slots over', async () => {
    const queue = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'] as const;
    const stepsFor: Record<(typeof queue)[number], number> = { p1: 3, p2: 1, p3: 2, p4: 4, p5: 1, p6: 2 };
    const observed = new Map<string, string[]>();
    const POOL_SIZE = 3;

    const runBranch = async (id: (typeof queue)[number]): Promise<void> => {
      await runWithSession(id, async () => {
        const seen: string[] = [];
        observed.set(id, seen);
        for (let step = 0; step < stepsFor[id]; step += 1) {
          await Promise.resolve();
          seen.push(currentSessionId() ?? 'MISSING');
        }
      });
    };

    const pending = new Set<Promise<void>>();
    let nextIdx = 0;
    const admitNext = (): void => {
      if (nextIdx >= queue.length) return;
      const id = queue[nextIdx]!;
      nextIdx += 1;
      const p: Promise<void> = runBranch(id).then(() => {
        pending.delete(p);
      });
      pending.add(p);
    };

    for (let i = 0; i < POOL_SIZE; i += 1) admitNext();
    while (pending.size > 0) {
      await Promise.race(pending);
      admitNext();
    }

    for (const id of queue) {
      expect(observed.get(id)).toStrictEqual(Array.from({ length: stepsFor[id] }, () => id));
    }
  });
});
