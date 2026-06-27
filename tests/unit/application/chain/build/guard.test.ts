import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import type { TraceEntry } from '@src/application/chain/trace.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { guard } from '@src/application/chain/build/guard.ts';

interface Ctx {
  readonly trail: readonly string[];
}

/** A leaf that appends its name to the ctx trail — proves the body actually ran and threaded ctx. */
const tag = (name: string): Element<Ctx> =>
  leaf<Ctx, Ctx, Ctx>(name, {
    useCase: {
      async execute(input) {
        return Result.ok({ trail: [...input.trail, name] });
      },
    },
    input: (c) => c,
    output: (_c, o) => o,
  });

/** A leaf that always fails — proves a body error propagates through the guard. */
const fail = (name: string): Element<Ctx> =>
  leaf<Ctx, unknown, unknown>(name, {
    useCase: {
      async execute() {
        return Result.error(new ValidationError({ field: name, value: 0, message: `${name} failed` }));
      },
    },
    input: () => undefined,
    output: (c) => c,
  });

describe('guard', () => {
  it('skips the body and emits a skipped trace entry when the predicate returns false', async () => {
    let bodyRan = false;
    const body = leaf<Ctx, Ctx, Ctx>('body', {
      useCase: {
        async execute(input) {
          bodyRan = true;
          return Result.ok(input);
        },
      },
      input: (c) => c,
      output: (_c, o) => o,
    });

    const result = await guard<Ctx>('only-when', () => false, body).execute({ trail: ['start'] });

    expect(bodyRan).toBe(false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // ctx is threaded through unchanged when the body is skipped.
      expect(result.value.ctx).toEqual({ trail: ['start'] });
      // The single trace entry names the BODY (not the guard) with `skipped` status.
      expect(result.value.trace.map((e) => `${e.elementName}:${e.status}`)).toEqual(['body:skipped']);
    }
  });

  it('forwards the skipped entry through onTrace so the live stream matches the final trace', async () => {
    const emitted: TraceEntry[] = [];
    await guard<Ctx>('only-when', () => false, tag('body')).execute({ trail: [] }, undefined, (e) => emitted.push(e));

    expect(emitted.map((e) => `${e.elementName}:${e.status}`)).toEqual(['body:skipped']);
  });

  it('runs the body and returns its result when the predicate returns true', async () => {
    const result = await guard<Ctx>('only-when', () => true, tag('body')).execute({ trail: ['start'] });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ctx).toEqual({ trail: ['start', 'body'] });
      expect(result.value.trace.map((e) => `${e.elementName}:${e.status}`)).toEqual(['body:completed']);
    }
  });

  it('propagates the body failure verbatim when the predicate returns true and the body fails', async () => {
    const result = await guard<Ctx>('only-when', () => true, fail('body')).execute({ trail: [] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBeInstanceOf(ValidationError);
      expect(result.error.trace.at(-1)?.elementName).toBe('body');
      expect(result.error.trace.at(-1)?.status).toBe('failed');
    }
  });

  it('short-circuits to aborted — evaluating neither predicate nor body — when the signal is already tripped', async () => {
    let predicateRan = false;
    let bodyRan = false;
    const body = leaf<Ctx, Ctx, Ctx>('body', {
      useCase: {
        async execute(input) {
          bodyRan = true;
          return Result.ok(input);
        },
      },
      input: (c) => c,
      output: (_c, o) => o,
    });

    const ac = new AbortController();
    ac.abort();
    const result = await guard<Ctx>(
      'only-when',
      () => {
        predicateRan = true;
        return true;
      },
      body
    ).execute({ trail: [] }, ac.signal);

    expect(predicateRan).toBe(false);
    expect(bodyRan).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBeInstanceOf(AbortError);
      // The pre-execution abort entry carries the GUARD name (built by `checkAborted`), not the body's.
      expect(result.error.trace[0]?.elementName).toBe('only-when');
      expect(result.error.trace[0]?.status).toBe('aborted');
    }
  });
});
