import { describe, expect, it, vi } from 'vitest';
import { Result } from 'typescript-result';

import type { ChainTraceEntry, KernelError } from './element.ts';
import type { LeafUseCase } from './leaf.ts';
import { Leaf } from './leaf.ts';

interface Ctx {
  readonly userId: string;
  readonly profile?: string;
}

interface FetchInput {
  readonly id: string;
}
type FetchOutput = string;

const okUseCase: LeafUseCase<FetchInput, FetchOutput> = {
  execute: (input) => Promise.resolve(Result.ok(`profile-of-${input.id}`) as Result<FetchOutput, KernelError>),
};

describe('Leaf', () => {
  it('threads ctx through input and output mappers on success', async () => {
    const inputSpy = vi.fn((ctx: Ctx) => ({ id: ctx.userId }));
    const outputSpy = vi.fn((ctx: Ctx, profile: FetchOutput): Ctx => ({ ...ctx, profile }));
    const leaf = new Leaf<Ctx, FetchInput, FetchOutput>('fetch-profile', {
      useCase: okUseCase,
      input: inputSpy,
      output: outputSpy,
    });

    const result = await leaf.execute({ userId: 'u1' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx).toStrictEqual({ userId: 'u1', profile: 'profile-of-u1' });
    expect(inputSpy).toHaveBeenCalledWith({ userId: 'u1' });
    expect(outputSpy).toHaveBeenCalledWith({ userId: 'u1' }, 'profile-of-u1');
    expect(result.value.trace).toHaveLength(1);
    expect(result.value.trace[0]?.status).toBe('completed');
    expect(result.value.trace[0]?.stepName).toBe('fetch-profile');
  });

  it('propagates use-case failure unchanged and leaves ctx untouched', async () => {
    const err: KernelError = { code: 'not-found', message: 'no such user' };
    const failingUseCase: LeafUseCase<FetchInput, FetchOutput> = {
      execute: () => Promise.resolve(Result.error(err) as Result<FetchOutput, KernelError>),
    };
    const outputSpy = vi.fn((ctx: Ctx, profile: FetchOutput): Ctx => ({ ...ctx, profile }));
    const leaf = new Leaf<Ctx, FetchInput, FetchOutput>('fetch-profile', {
      useCase: failingUseCase,
      input: (ctx) => ({ id: ctx.userId }),
      output: outputSpy,
    });

    const result = await leaf.execute({ userId: 'u1' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBe(err);
    expect(outputSpy).not.toHaveBeenCalled();
    expect(result.error.trace[0]?.status).toBe('failed');
  });

  it('emits one onTrace entry on success before resolving', async () => {
    const leaf = new Leaf<Ctx, FetchInput, FetchOutput>('fetch-profile', {
      useCase: okUseCase,
      input: (ctx) => ({ id: ctx.userId }),
      output: (ctx, profile): Ctx => ({ ...ctx, profile }),
    });
    const seen: ChainTraceEntry[] = [];
    const result = await leaf.execute({ userId: 'u1' }, undefined, (entry) => seen.push(entry));

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.stepName).toBe('fetch-profile');
    expect(seen[0]?.status).toBe('completed');
  });

  it('emits one onTrace entry on failure before resolving', async () => {
    const err: KernelError = { code: 'not-found', message: 'no such user' };
    const leaf = new Leaf<Ctx, FetchInput, FetchOutput>('fetch-profile', {
      useCase: { execute: () => Promise.resolve(Result.error(err) as Result<FetchOutput, KernelError>) },
      input: (ctx) => ({ id: ctx.userId }),
      output: (ctx, profile): Ctx => ({ ...ctx, profile }),
    });
    const seen: ChainTraceEntry[] = [];
    await leaf.execute({ userId: 'u1' }, undefined, (entry) => seen.push(entry));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.status).toBe('failed');
    expect(seen[0]?.error).toBe(err);
  });

  it('propagates AbortSignal to the use case so in-flight calls can cancel', async () => {
    const signalSeen: { aborted?: boolean } = {};
    const abortAware: LeafUseCase<FetchInput, FetchOutput> = {
      execute: (_input, signal) =>
        new Promise<Result<FetchOutput, KernelError>>((resolve) => {
          const timer = setTimeout(() => {
            resolve(Result.ok('late'));
          }, 50);
          if (signal) {
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                signalSeen.aborted = true;
                resolve(Result.ok('cancelled'));
              },
              { once: true }
            );
          }
        }),
    };
    const leaf = new Leaf<Ctx, FetchInput, FetchOutput>('fetch-profile', {
      useCase: abortAware,
      input: (ctx) => ({ id: ctx.userId }),
      output: (ctx, profile): Ctx => ({ ...ctx, profile }),
    });

    const ac = new AbortController();
    const promise = leaf.execute({ userId: 'u1' }, ac.signal);
    setTimeout(() => {
      ac.abort();
    }, 5);
    const result = await promise;

    expect(signalSeen.aborted).toBe(true);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe('aborted');
  });
});
