import { describe, expect, it } from 'vitest';
import { executePipeline } from './pipeline.ts';
import { pipeline, step } from './helpers.ts';
import type { DomainResult } from '@src/domain/types.ts';
import { Result } from '@src/domain/types.ts';
import { StepError } from '@src/domain/errors.ts';
import type { StepContext } from '@src/domain/context.ts';

/**
 * Extended context for testing. Fields added here are merged via
 * `Partial<TestContext>` in step return values.
 */
interface TestContext extends StepContext {
  counter?: number;
  label?: string;
  trace?: string[];
}

function makeCtx(overrides: Partial<TestContext> = {}): TestContext {
  return { sprintId: 'test-sprint', ...overrides };
}

/** Helper to unwrap a successful result in tests */
function unwrap<T>(result: DomainResult<T>): T {
  expect(result.ok).toBe(true);
  return result.value as T;
}

/** Helper to unwrap a failed result's error in tests */
function unwrapErr<T>(result: DomainResult<T>): StepError {
  expect(result.ok).toBe(false);
  return result.error as StepError;
}

describe('executePipeline', () => {
  it('returns initial context for empty pipeline', async () => {
    const p = pipeline<TestContext>('empty', []);
    const result = await executePipeline(p, makeCtx({ counter: 42 }));

    const { context, stepResults } = unwrap(result);
    expect(context.counter).toBe(42);
    expect(stepResults).toEqual([]);
  });

  it('single step modifies context', async () => {
    const p = pipeline<TestContext>('single', [step<TestContext>('set-counter', () => Result.ok({ counter: 100 }))]);
    const result = await executePipeline(p, makeCtx());

    const { context, stepResults } = unwrap(result);
    expect(context.counter).toBe(100);
    expect(stepResults).toHaveLength(1);
    expect(stepResults[0]?.status).toBe('success');
  });

  it('multi-step pipeline chains context through steps', async () => {
    const p = pipeline<TestContext>('chain', [
      step<TestContext>('first', () => Result.ok({ counter: 10 })),
      step<TestContext>('second', (c) => Result.ok({ counter: (c.counter ?? 0) * 2 })),
      step<TestContext>('third', (c) => Result.ok({ label: `result-${String(c.counter)}` })),
    ]);
    const result = await executePipeline(p, makeCtx());

    const { context, stepResults } = unwrap(result);
    expect(context.counter).toBe(20);
    expect(context.label).toBe('result-20');
    expect(stepResults).toHaveLength(3);
    expect(stepResults.every((r) => r.status === 'success')).toBe(true);
  });

  it('step failure stops pipeline and returns StepError', async () => {
    const p = pipeline<TestContext>('fail-mid', [
      step<TestContext>('ok-step', () => Result.ok({ counter: 1 })),
      step<TestContext>('bad-step', () => Result.error(new StepError('boom', 'bad-step'))),
      step<TestContext>('never-reached', () => Result.ok({ counter: 999 })),
    ]);
    const result = await executePipeline(p, makeCtx());

    const error = unwrapErr(result);
    expect(error).toBeInstanceOf(StepError);
    expect(error.stepName).toBe('bad-step');
    expect(error.message).toContain('bad-step');
    expect(error.message).toContain('boom');
  });

  it('pre-hook modifies context before step executes', async () => {
    const p = pipeline<TestContext>('pre-hook', [
      step<TestContext>('hooked', (c) => Result.ok({ counter: (c.counter ?? 0) + 1 }), {
        pre: (c) => Result.ok({ ...c, counter: 10 }),
      }),
    ]);
    const result = await executePipeline(p, makeCtx());

    const { context } = unwrap(result);
    expect(context.counter).toBe(11);
  });

  it('post-hook modifies result after step executes', async () => {
    const p = pipeline<TestContext>('post-hook', [
      step<TestContext>('hooked', () => Result.ok({ counter: 5 }), {
        post: (_c, partial) => Result.ok({ ...partial, label: 'post-modified' }),
      }),
    ]);
    const result = await executePipeline(p, makeCtx());

    const { context } = unwrap(result);
    expect(context.counter).toBe(5);
    expect(context.label).toBe('post-modified');
  });

  it('pre-hook failure stops pipeline with StepError', async () => {
    const p = pipeline<TestContext>('pre-fail', [
      step<TestContext>('hooked', () => Result.ok({ counter: 1 }), {
        pre: () => Result.error(new StepError('pre failed', 'hooked')),
      }),
    ]);
    const result = await executePipeline(p, makeCtx());

    const error = unwrapErr(result);
    expect(error).toBeInstanceOf(StepError);
    expect(error.message).toContain('Pre-hook failed');
    expect(error.message).toContain('pre failed');
  });

  it('post-hook failure stops pipeline with StepError', async () => {
    const p = pipeline<TestContext>('post-fail', [
      step<TestContext>('hooked', () => Result.ok({ counter: 1 }), {
        post: () => Result.error(new StepError('post failed', 'hooked')),
      }),
    ]);
    const result = await executePipeline(p, makeCtx());

    const error = unwrapErr(result);
    expect(error).toBeInstanceOf(StepError);
    expect(error.message).toContain('Post-hook failed');
    expect(error.message).toContain('post failed');
  });

  it('unexpected throw in step is caught and wrapped in StepError', async () => {
    const p = pipeline<TestContext>('throw', [
      // eslint-disable-next-line @typescript-eslint/require-await -- async needed to produce rejected Promise
      step<TestContext>('kaboom', async () => {
        throw new Error('unexpected crash');
      }),
    ]);
    const result = await executePipeline(p, makeCtx());

    const error = unwrapErr(result);
    expect(error).toBeInstanceOf(StepError);
    expect(error.stepName).toBe('kaboom');
    expect(error.message).toContain('Unexpected error');
    expect(error.message).toContain('unexpected crash');
  });

  it('records step diagnostics with name, status, and duration', async () => {
    const p = pipeline<TestContext>('diagnostics', [
      step<TestContext>('fast', () => Result.ok({ counter: 1 })),
      step<TestContext>('also-fast', () => Result.ok({ label: 'done' })),
    ]);
    const result = await executePipeline(p, makeCtx());

    const { stepResults } = unwrap(result);
    expect(stepResults).toHaveLength(2);
    expect(stepResults[0]?.stepName).toBe('fast');
    expect(stepResults[0]?.status).toBe('success');
    expect(stepResults[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(stepResults[1]?.stepName).toBe('also-fast');
    expect(stepResults[1]?.status).toBe('success');
  });

  it('non-Error throw is coerced to string in StepError', async () => {
    const p = pipeline<TestContext>('string-throw', [
      // eslint-disable-next-line @typescript-eslint/require-await -- async needed to produce rejected Promise
      step<TestContext>('bad', async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'string error';
      }),
    ]);
    const result = await executePipeline(p, makeCtx());

    const error = unwrapErr(result);
    expect(error.message).toContain('string error');
  });

  it('preserves initial context fields not touched by steps', async () => {
    const p = pipeline<TestContext>('preserve', [step<TestContext>('only-label', () => Result.ok({ label: 'added' }))]);
    const result = await executePipeline(p, makeCtx({ counter: 7 }));

    const { context } = unwrap(result);
    expect(context.counter).toBe(7);
    expect(context.label).toBe('added');
    expect(context.sprintId).toBe('test-sprint');
  });
});

describe('step helper', () => {
  it('creates a PipelineStep with name and execute', () => {
    const s = step<TestContext>('test', () => Result.ok({}));
    expect(s.name).toBe('test');
    expect(typeof s.execute).toBe('function');
    expect(s.hooks).toBeUndefined();
  });

  it('creates a PipelineStep with hooks', () => {
    const s = step<TestContext>('test', () => Result.ok({}), {
      pre: (c) => Result.ok(c),
      post: (_c, r) => Result.ok(r),
    });
    expect(s.hooks?.pre).toBeDefined();
    expect(s.hooks?.post).toBeDefined();
  });
});

describe('pipeline helper', () => {
  it('creates a PipelineDefinition with name and steps', () => {
    const s = step<TestContext>('s1', () => Result.ok({}));
    const p = pipeline<TestContext>('test-pipeline', [s]);
    expect(p.name).toBe('test-pipeline');
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0]).toBe(s);
  });
});
