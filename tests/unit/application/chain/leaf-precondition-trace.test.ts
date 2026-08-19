/**
 * A leaf's `input()` / `output()` projectors may throw a `DomainError` to report a precondition
 * violation — "an upstream leaf should have produced ctx.<field> and didn't". The chain turns those
 * into a normal `failed` trace entry for the offending leaf (so the TUI rail shows exactly which
 * step broke) while the surrounding `sequential` marks the steps after it `skipped`.
 *
 * Any OTHER throw is a programmer bug and must re-propagate untouched — the runner, not the leaf,
 * is the containment boundary for those. Node errno errors (EACCES, ELOOP …) are the motivating
 * non-domain case: they carry a string `code` too, and must never be laundered into the
 * domain-error channel just because an adapter threw one instead of returning `Result.error`.
 */

import { describe, expect, it } from 'vitest';

import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { ErrorCode } from '@src/domain/value/error/error-code.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import { assertCtxField } from '@src/application/flows/_shared/_engine/assert-ctx-field.ts';
import type { TraceEntry } from '@src/application/chain/trace.ts';

interface Ctx {
  readonly sprint?: string;
  readonly ran: readonly string[];
}

const CTX: Ctx = { ran: [] };

/** Records that it ran; never inspects the missing field. */
const passthrough = (name: string) =>
  leaf<Ctx, Ctx, Ctx>(name, {
    useCase: {
      async execute(input) {
        return Result.ok({ ...input, ran: [...input.ran, name] });
      },
    },
    input: (c) => c,
    output: (_c, o) => o,
  });

/** Projector asserts a ctx field an upstream leaf was supposed to have produced. */
const requiresSprint = (name: string) => {
  let called = false;
  const element = leaf<Ctx, { readonly sprint: string }, Ctx>(name, {
    useCase: {
      async execute() {
        called = true;
        return Result.ok(CTX);
      },
    },
    input: (c) => ({ sprint: assertCtxField(c, 'sprint', name) }),
    output: (c) => c,
  });
  return { element, wasUseCaseCalled: (): boolean => called };
};

describe('leaf precondition throws', () => {
  it('turns an InvalidStateError from input() into a failed entry named after that leaf', async () => {
    const emitted: TraceEntry[] = [];
    const { element, wasUseCaseCalled } = requiresSprint('save-sprint');

    const result = await element.execute(CTX, undefined, (e) => emitted.push(e));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBeInstanceOf(InvalidStateError);
      expect(result.error.trace).toHaveLength(1);
      expect(result.error.trace[0]?.elementName).toBe('save-sprint');
      expect(result.error.trace[0]?.status).toBe('failed');
      expect(result.error.trace[0]?.error).toBe(result.error.error);
    }
    // The projector threw before the use case could be reached.
    expect(wasUseCaseCalled()).toBe(false);
    // Emitted progressively, exactly once.
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.status).toBe('failed');
  });

  it('marks the siblings after the failing leaf as skipped', async () => {
    const { element } = requiresSprint('save-sprint');
    const chain = sequential<Ctx>('flow', [passthrough('load'), element, passthrough('notify'), passthrough('close')]);

    const result = await chain.execute(CTX);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.trace.map((e) => [e.elementName, e.status])).toEqual([
        ['load', 'completed'],
        ['save-sprint', 'failed'],
        ['notify', 'skipped'],
        ['close', 'skipped'],
      ]);
    }
  });

  it('re-propagates a raw Error from input() — a programmer bug is not a trace entry', async () => {
    const emitted: TraceEntry[] = [];
    const element = leaf<Ctx, unknown, Ctx>('projector-bug', {
      useCase: {
        async execute() {
          return Result.ok(CTX);
        },
      },
      input: () => {
        throw new TypeError('cannot read properties of undefined');
      },
      output: (c) => c,
    });

    await expect(element.execute(CTX, undefined, (e) => emitted.push(e))).rejects.toThrow(TypeError);
    expect(emitted).toHaveLength(0);
  });

  it('re-propagates a raw Error from output() too', async () => {
    const element = leaf<Ctx, Ctx, Ctx>('merge-bug', {
      useCase: {
        async execute(input) {
          return Result.ok(input);
        },
      },
      input: (c) => c,
      output: () => {
        throw new TypeError('merge exploded');
      },
    });

    await expect(element.execute(CTX)).rejects.toThrow('merge exploded');
  });

  it('re-propagates a Node errno error from input() — a string `code` is not a domain code', async () => {
    const emitted: TraceEntry[] = [];
    const element = leaf<Ctx, unknown, Ctx>('errno-projector', {
      useCase: {
        async execute() {
          return Result.ok(CTX);
        },
      },
      input: () => {
        throw errno('EACCES: permission denied', 'EACCES');
      },
      output: (c) => c,
    });

    await expect(element.execute(CTX, undefined, (e) => emitted.push(e))).rejects.toThrow('EACCES: permission denied');
    expect(emitted).toHaveLength(0);
  });

  it('re-propagates a Node errno error thrown by the use case (the adapter-I/O shape)', async () => {
    const emitted: TraceEntry[] = [];
    const element = leaf<Ctx, Ctx, Ctx>('install-skills', {
      useCase: {
        async execute() {
          throw errno('ELOOP: too many symbolic links', 'ELOOP');
        },
      },
      input: (c) => c,
      output: (_c, o) => o,
    });

    await expect(element.execute(CTX, undefined, (e) => emitted.push(e))).rejects.toThrow(
      'ELOOP: too many symbolic links'
    );
    expect(emitted).toHaveLength(0);
  });

  it('still turns a real DomainError thrown by the use case into a failed entry', async () => {
    const element = leaf<Ctx, Ctx, Ctx>('save-sprint', {
      useCase: {
        async execute() {
          throw new InvalidStateError({ entity: 'sprint', currentState: 'draft', attemptedAction: 'save' });
        },
      },
      input: (c) => c,
      output: (_c, o) => o,
    });

    const result = await element.execute(CTX);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.error).toBeInstanceOf(InvalidStateError);
    expect(result.error.trace[0]?.status).toBe('failed');
    expect(result.error.trace[0]?.elementName).toBe('save-sprint');
  });

  it('still turns an AbortError thrown by the use case into an aborted entry', async () => {
    const element = leaf<Ctx, Ctx, Ctx>('long-step', {
      useCase: {
        async execute() {
          throw new AbortError({ elementName: 'long-step' });
        },
      },
      input: (c) => c,
      output: (_c, o) => o,
    });

    const result = await element.execute(CTX);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.error).toBeInstanceOf(AbortError);
    expect(result.error.trace[0]?.status).toBe('aborted');
  });
});

/** A Node-shaped errno error: a real `Error` carrying a string `code` that is not an `ErrorCode`. */
const errno = (message: string, code: string): Error => Object.assign(new Error(message), { code });

describe('DomainError code registry', () => {
  it('every DomainError class assigns a registered ErrorCode (compile-time fence)', () => {
    // The exact-membership predicate in leaf.ts makes this correspondence load-bearing: a new
    // error class with an unregistered `code` literal would compile, satisfy the union, and then
    // silently re-throw past the leaf instead of tracing as `failed`. This line makes that a
    // typecheck failure instead.
    const fence: Exclude<DomainError['code'], ErrorCode> extends never ? true : never = true;
    expect(fence).toBe(true);
  });
});
