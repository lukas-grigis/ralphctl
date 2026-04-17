import { describe, expect, it } from 'vitest';
import type { DomainResult } from '@src/domain/types.ts';
import { Result } from '@src/domain/types.ts';
import { ParseError, StepError } from '@src/domain/errors.ts';
import type { StepContext } from '@src/domain/context.ts';
import { executePipeline } from './pipeline.ts';
import { insertAfter, insertBefore, nested, pipeline, renameStep, replace, step } from './helpers.ts';

interface TestContext extends StepContext {
  counter?: number;
  label?: string;
  trace?: string[];
}

function makeCtx(overrides: Partial<TestContext> = {}): TestContext {
  return { sprintId: 'test-sprint', ...overrides };
}

function unwrap<T>(result: DomainResult<T>): T {
  expect(result.ok).toBe(true);
  return result.value as T;
}

function unwrapErr<T>(result: DomainResult<T>): StepError {
  expect(result.ok).toBe(false);
  return result.error as StepError;
}

// ---------------------------------------------------------------------------
// nested
// ---------------------------------------------------------------------------

describe('nested', () => {
  it('propagates inner pipeline context to outer', async () => {
    const inner = pipeline<TestContext>('inner', [
      step<TestContext>('set-counter', () => Result.ok({ counter: 7 })),
      step<TestContext>('set-label', () => Result.ok({ label: 'from-inner' })),
    ]);
    const outer = pipeline<TestContext>('outer', [
      step<TestContext>('before', () => Result.ok({ counter: 1 })),
      nested<TestContext>('run-inner', inner),
      step<TestContext>('after', (c) => Result.ok({ label: `${c.label ?? ''}-plus` })),
    ]);

    const result = await executePipeline(outer, makeCtx());
    const { context } = unwrap(result);
    expect(context.counter).toBe(7);
    expect(context.label).toBe('from-inner-plus');
  });

  it('wraps inner failure as StepError with prefixed step path', async () => {
    const inner = pipeline<TestContext>('inner-pipeline', [
      step<TestContext>('ok', () => Result.ok({ counter: 1 })),
      step<TestContext>('fail', () => Result.error(new ParseError('bad data'))),
    ]);
    const outer = pipeline<TestContext>('outer', [nested<TestContext>('run-inner', inner)]);

    const result = await executePipeline(outer, makeCtx());
    const error = unwrapErr(result);
    expect(error).toBeInstanceOf(StepError);
    // The outer executePipeline wraps with "Step 'run-inner' failed: ..."
    // and our nested helper contributes "[run-inner > fail] bad data"
    expect(error.message).toContain('run-inner > fail');
    expect(error.message).toContain('bad data');
  });

  it('propagates unknown thrown errors from inner as StepError', async () => {
    const inner = pipeline<TestContext>('inner', [
      // eslint-disable-next-line @typescript-eslint/require-await -- need async to throw
      step<TestContext>('boom', async () => {
        throw new Error('unexpected');
      }),
    ]);
    const outer = pipeline<TestContext>('outer', [nested<TestContext>('wrapper', inner)]);
    const result = await executePipeline(outer, makeCtx());
    const error = unwrapErr(result);
    expect(error.message).toContain('wrapper');
    expect(error.message).toContain('unexpected');
  });
});

// ---------------------------------------------------------------------------
// insertBefore / insertAfter / replace
// ---------------------------------------------------------------------------

describe('insertBefore', () => {
  it('inserts the new step before the target', () => {
    const a = step<TestContext>('a', () => Result.ok({}));
    const b = step<TestContext>('b', () => Result.ok({}));
    const c = step<TestContext>('c', () => Result.ok({}));
    const p = pipeline<TestContext>('p', [a, b, c]);
    const injected = step<TestContext>('injected', () => Result.ok({}));

    const modified = insertBefore(p, 'b', injected);
    expect(modified.steps.map((s) => s.name)).toEqual(['a', 'injected', 'b', 'c']);
  });

  it('throws when target step does not exist', () => {
    const p = pipeline<TestContext>('p', [step<TestContext>('a', () => Result.ok({}))]);
    const injected = step<TestContext>('x', () => Result.ok({}));
    expect(() => insertBefore(p, 'missing', injected)).toThrow(/not found/);
  });

  it('returns a new definition without mutating the input', () => {
    const p = pipeline<TestContext>('p', [
      step<TestContext>('a', () => Result.ok({})),
      step<TestContext>('b', () => Result.ok({})),
    ]);
    const injected = step<TestContext>('x', () => Result.ok({}));
    const modified = insertBefore(p, 'b', injected);
    expect(p.steps.map((s) => s.name)).toEqual(['a', 'b']);
    expect(modified).not.toBe(p);
  });
});

describe('insertAfter', () => {
  it('inserts the new step after the target', () => {
    const a = step<TestContext>('a', () => Result.ok({}));
    const b = step<TestContext>('b', () => Result.ok({}));
    const c = step<TestContext>('c', () => Result.ok({}));
    const p = pipeline<TestContext>('p', [a, b, c]);
    const injected = step<TestContext>('injected', () => Result.ok({}));

    const modified = insertAfter(p, 'b', injected);
    expect(modified.steps.map((s) => s.name)).toEqual(['a', 'b', 'injected', 'c']);
  });

  it('appends at the end when target is last', () => {
    const a = step<TestContext>('a', () => Result.ok({}));
    const p = pipeline<TestContext>('p', [a]);
    const injected = step<TestContext>('injected', () => Result.ok({}));
    const modified = insertAfter(p, 'a', injected);
    expect(modified.steps.map((s) => s.name)).toEqual(['a', 'injected']);
  });

  it('throws when target step does not exist', () => {
    const p = pipeline<TestContext>('p', [step<TestContext>('a', () => Result.ok({}))]);
    expect(() =>
      insertAfter(
        p,
        'missing',
        step<TestContext>('x', () => Result.ok({}))
      )
    ).toThrow(/not found/);
  });
});

describe('replace', () => {
  it('replaces the target step', () => {
    const a = step<TestContext>('a', () => Result.ok({}));
    const b = step<TestContext>('b', () => Result.ok({}));
    const c = step<TestContext>('c', () => Result.ok({}));
    const p = pipeline<TestContext>('p', [a, b, c]);
    const repl = step<TestContext>('new-b', () => Result.ok({}));

    const modified = replace(p, 'b', repl);
    expect(modified.steps.map((s) => s.name)).toEqual(['a', 'new-b', 'c']);
  });

  it('throws when target step does not exist', () => {
    const p = pipeline<TestContext>('p', [step<TestContext>('a', () => Result.ok({}))]);
    expect(() =>
      replace(
        p,
        'missing',
        step<TestContext>('x', () => Result.ok({}))
      )
    ).toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// renameStep
// ---------------------------------------------------------------------------

describe('renameStep', () => {
  it('renames the step without altering execute or hooks', async () => {
    const original = step<TestContext>('generic-name', () => Result.ok({ counter: 42 }), {
      pre: (ctx) => Result.ok({ ...ctx, label: 'pre-ran' }),
    });
    const renamed = renameStep('specific-name', original);

    expect(renamed.name).toBe('specific-name');
    expect(renamed.execute).toBe(original.execute);
    expect(renamed.hooks).toBe(original.hooks);

    // Confirm the renamed step runs exactly the same way in a pipeline.
    const p = pipeline<TestContext>('p', [renamed]);
    const result = await executePipeline(p, makeCtx());
    const { context, stepResults } = unwrap(result);
    expect(stepResults.map((r) => r.stepName)).toEqual(['specific-name']);
    expect(context.counter).toBe(42);
    expect(context.label).toBe('pre-ran');
  });
});
