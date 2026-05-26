/**
 * Invariant test — `AbortError` propagation through every chain primitive.
 *
 * CLAUDE.md § Security & Safety:
 *   "AbortError is the one error chains propagate transparently. User-initiated cancellation
 *    (Ctrl+C, the TUI abort hotkey) flows through every wrapper without being absorbed by
 *    guards or fallbacks."
 *
 * This file locks that invariant in place: each chain primitive (`guard`, `sequential`,
 * `loop`) MUST surface an `AbortError` raised by its body — never swallow it, never convert
 * it to a non-aborted Result. The two pathways exercised per primitive:
 *
 *   1. The leaf's useCase returns `Result.error(AbortError)` (the common case — the headless
 *      provider, the InkInteractivePrompt, etc. all produce AbortError this way).
 *   2. The leaf's useCase THROWS `AbortError` synchronously (the `leaf.ts:56` catch path —
 *      AbortError IS a DomainError, so it must be re-wrapped as Result.error, not re-thrown
 *      as an opaque programmer-bug throw).
 *
 * `rate-limit-backoff.ts` and `idle-watchdog.ts` are also covered — they participate in the
 * cancellation path (Ctrl-C during a 2-hour backoff, AbortSignal-driven SIGTERM ladder).
 * They have no try/catch that observes the user's `AbortSignal`, but the tests assert the
 * documented short-circuit behaviour stays intact.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf, type LeafUseCase } from '@src/application/chain/build/leaf.ts';
import { guard } from '@src/application/chain/build/guard.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import { loop } from '@src/application/chain/build/loop.ts';
import { installIdleWatchdog } from '@src/integration/ai/providers/_engine/idle-watchdog.ts';
import { sleepCancellable } from '@src/integration/ai/providers/_engine/rate-limit-backoff.ts';

interface Ctx {
  readonly trail: readonly string[];
}

const INITIAL: Ctx = { trail: [] };

/** A leaf whose useCase returns `Result.error(AbortError)` — the common "I was cancelled" shape. */
const abortingLeaf = (name: string): Element<Ctx> =>
  leaf<Ctx, unknown, unknown>(name, {
    useCase: {
      async execute() {
        return Result.error(new AbortError({ elementName: name, reason: 'simulated cancel' }));
      },
    },
    input: () => undefined,
    output: (c) => c,
  });

/** A leaf whose useCase THROWS AbortError — exercises the `leaf.ts:56` DomainError-catch path. */
const throwingAbortLeaf = (name: string): Element<Ctx> =>
  leaf<Ctx, unknown, unknown>(name, {
    useCase: {
      async execute() {
        throw new AbortError({ elementName: name, reason: 'simulated throw cancel' });
      },
    },
    input: () => undefined,
    output: (c) => c,
  });

/** A normal leaf that tags its name onto the trail — used to assert downstream short-circuit. */
const tagLeaf = (name: string): Element<Ctx> =>
  leaf<Ctx, Ctx, Ctx>(name, {
    useCase: {
      async execute(input) {
        return Result.ok({ trail: [...input.trail, name] });
      },
    },
    input: (c) => c,
    output: (_c, o) => o,
  });

const isAbortedFailure = (err: { readonly error: { readonly code: string } }): boolean => err.error.code === 'aborted';

describe('AbortError propagation invariant', () => {
  describe('leaf', () => {
    it('propagates AbortError returned by the useCase as a Result.error with code "aborted"', async () => {
      const el = abortingLeaf('a');
      const result = await el.execute(INITIAL);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error).toBeInstanceOf(AbortError);
        expect(isAbortedFailure(result.error)).toBe(true);
      }
    });

    it('propagates AbortError thrown by the useCase as a Result.error with code "aborted"', async () => {
      const el = throwingAbortLeaf('a');
      const result = await el.execute(INITIAL);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error).toBeInstanceOf(AbortError);
        expect(isAbortedFailure(result.error)).toBe(true);
      }
    });
  });

  describe('guard', () => {
    it('propagates AbortError from its body when the predicate passes (Result-side)', async () => {
      const wrapped = guard<Ctx>('g', () => true, abortingLeaf('a'));
      const result = await wrapped.execute(INITIAL);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error).toBeInstanceOf(AbortError);
        expect(isAbortedFailure(result.error)).toBe(true);
      }
    });

    it('propagates AbortError from its body when the useCase throws (catch-side)', async () => {
      const wrapped = guard<Ctx>('g', () => true, throwingAbortLeaf('a'));
      const result = await wrapped.execute(INITIAL);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error).toBeInstanceOf(AbortError);
        expect(isAbortedFailure(result.error)).toBe(true);
      }
    });

    it('returns aborted when the signal is already tripped (does not swallow into "skipped")', async () => {
      const wrapped = guard<Ctx>('g', () => true, tagLeaf('a'));
      const ac = new AbortController();
      ac.abort();
      const result = await wrapped.execute(INITIAL, ac.signal);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error).toBeInstanceOf(AbortError);
        expect(isAbortedFailure(result.error)).toBe(true);
      }
    });
  });

  describe('sequential', () => {
    it('propagates AbortError from a child and short-circuits the remaining children', async () => {
      const chain = sequential<Ctx>('s', [tagLeaf('a'), abortingLeaf('b'), tagLeaf('c')]);
      const result = await chain.execute(INITIAL);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error).toBeInstanceOf(AbortError);
        expect(isAbortedFailure(result.error)).toBe(true);
        // Trace ends with the aborted child + the synthetic skip for 'c'.
        const names = result.error.trace.map((t) => t.elementName);
        expect(names).toEqual(['a', 'b', 'c']);
        const statuses = result.error.trace.map((t) => t.status);
        expect(statuses).toEqual(['completed', 'failed', 'skipped']);
      }
    });

    it('propagates AbortError thrown synchronously by a child useCase', async () => {
      const chain = sequential<Ctx>('s', [tagLeaf('a'), throwingAbortLeaf('b')]);
      const result = await chain.execute(INITIAL);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error).toBeInstanceOf(AbortError);
        expect(isAbortedFailure(result.error)).toBe(true);
      }
    });

    it('does NOT convert AbortError into a non-aborted DomainError when followed by a guard fallback', async () => {
      // Worst-case shape: an aborting leaf wrapped by a guard with an always-true predicate. The
      // guard MUST surface the AbortError verbatim — no "code !== aborted" fallback path may
      // catch it and continue.
      const guarded = guard<Ctx>('g', () => true, abortingLeaf('b'));
      const chain = sequential<Ctx>('s', [tagLeaf('a'), guarded, tagLeaf('c')]);
      const result = await chain.execute(INITIAL);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error).toBeInstanceOf(AbortError);
        // `c` MUST be skipped — anything else means the abort got absorbed mid-chain.
        const cEntry = result.error.trace.find((t) => t.elementName === 'c');
        expect(cEntry?.status).toBe('skipped');
      }
    });
  });

  describe('loop', () => {
    it('propagates AbortError from its body on the first iteration', async () => {
      const looped = loop<Ctx>('l', abortingLeaf('body'), { maxIterations: 3 });
      const result = await looped.execute(INITIAL);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error).toBeInstanceOf(AbortError);
        expect(isAbortedFailure(result.error)).toBe(true);
      }
    });

    it('propagates AbortError thrown by the body useCase on the first iteration', async () => {
      const looped = loop<Ctx>('l', throwingAbortLeaf('body'), { maxIterations: 3 });
      const result = await looped.execute(INITIAL);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error).toBeInstanceOf(AbortError);
        expect(isAbortedFailure(result.error)).toBe(true);
      }
    });

    it('aborts mid-loop when the signal trips between iterations and does NOT mask it as a natural termination', async () => {
      const ac = new AbortController();
      // A body that increments the trail; after one successful iteration we trip the signal so
      // the next-iteration check in `loop.ts` fires the aborted branch.
      let iterations = 0;
      const body: Element<Ctx> = leaf<Ctx, Ctx, Ctx>('body', {
        useCase: {
          async execute(input) {
            iterations += 1;
            if (iterations >= 1) ac.abort();
            return Result.ok({ trail: [...input.trail, `i${String(iterations)}`] });
          },
        },
        input: (c) => c,
        output: (_c, o) => o,
      });
      const looped = loop<Ctx>('l', body, { maxIterations: 5 });

      const result = await looped.execute(INITIAL, ac.signal);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // The pre-iteration abort check in `loop.ts` fires an `aborted` trace entry — assert it.
        expect(result.error.error).toBeInstanceOf(AbortError);
        expect(isAbortedFailure(result.error)).toBe(true);
      }
    });
  });

  describe('nested composition — the worst case', () => {
    it('an AbortError raised at the deepest leaf travels through guard → loop → sequential without absorption', async () => {
      const inner = guard<Ctx>('g', () => true, abortingLeaf('deepest'));
      const looped = loop<Ctx>('l', inner, { maxIterations: 5 });
      const chain = sequential<Ctx>('s', [tagLeaf('before'), looped, tagLeaf('after')]);

      const result = await chain.execute(INITIAL);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error).toBeInstanceOf(AbortError);
        expect(isAbortedFailure(result.error)).toBe(true);
        // `after` must be a skip, never `completed`.
        const after = result.error.trace.find((t) => t.elementName === 'after');
        expect(after?.status).toBe('skipped');
      }
    });
  });

  describe('regression — leaf must not absorb AbortError into a "code !== aborted" branch', () => {
    it('a non-Abort DomainError from a useCase still surfaces normally (control case)', async () => {
      // Sanity check — the catch logic distinguishes AbortError from other DomainErrors. A
      // ValidationError must still surface as Result.error with code !== 'aborted', so a future
      // "exempt AbortError" patch can't accidentally bypass ALL DomainErrors.
      const failingLeaf: LeafUseCase<unknown, unknown> = {
        async execute() {
          return Result.error(new ValidationError({ field: 'x', value: 0, message: 'boom' }));
        },
      };
      const el = leaf<Ctx, unknown, unknown>('boom', {
        useCase: failingLeaf,
        input: () => undefined,
        output: (c) => c,
      });
      const result = await el.execute(INITIAL);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error).toBeInstanceOf(ValidationError);
        expect(result.error.error.code).not.toBe('aborted');
      }
    });
  });
});

describe('rate-limit-backoff — abort propagation', () => {
  it('sleepCancellable resolves immediately when the signal is already aborted (does not wait)', async () => {
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    await sleepCancellable(60_000, ac.signal);
    const elapsed = Date.now() - t0;
    // We can't measure 0 exactly under CI load, but a 1-minute sleep can NEVER take less than
    // a second to bail unless the abort short-circuit fired.
    expect(elapsed).toBeLessThan(1_000);
  });

  it('sleepCancellable resolves early when the signal fires mid-wait', async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 20);
    await sleepCancellable(60_000, ac.signal);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1_000);
  });
});

describe('idle-watchdog — abort propagation', () => {
  it('triggers the SIGTERM ladder when the abort signal fires (does not swallow the abort)', () => {
    // Minimal stub of the ChildProcess surface the watchdog reads. We only need stdout/stderr
    // EventEmitter shims + `kill` to assert the abort branch fires `kill('SIGTERM')`.
    const noop = (): void => undefined;
    const stdout = { on: noop, off: noop };
    const stderr = { on: noop, off: noop };
    const killArgs: string[] = [];
    const child = {
      stdout,
      stderr,
      kill: (signal: string): void => {
        killArgs.push(signal);
      },
    } as unknown as Parameters<typeof installIdleWatchdog>[0];

    const ac = new AbortController();
    const watchdog = installIdleWatchdog(child, {
      idleMs: 60_000,
      graceMs: 60_000,
      abortSignal: ac.signal,
    });

    ac.abort();
    // The watchdog's `killAbort` listener must have fired and called `child.kill('SIGTERM')`.
    expect(killArgs).toContain('SIGTERM');

    watchdog.stop();
  });
});
