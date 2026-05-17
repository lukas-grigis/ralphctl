import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';

import { checkAborted, type Element, type ElementResult } from '@src/application/chain/element.ts';
import type { TraceEntry } from '@src/application/chain/trace.ts';

export interface LeafUseCase<UInput, UOutput> {
  execute(input: UInput, signal?: AbortSignal): Promise<Result<UOutput, DomainError>>;
}

export interface LeafConfig<TCtx, UInput, UOutput> {
  readonly useCase: LeafUseCase<UInput, UOutput>;
  /**
   * Project ctx → input. May throw a `DomainError` to surface a precondition violation
   * (e.g. `ctx.sprint` undefined upstream); those throws become `failed` trace entries.
   * Any other throw is a programmer bug and re-propagates.
   */
  readonly input: (ctx: TCtx) => UInput;
  /** Merge use-case output into a new ctx. Same throw semantics as `input`. */
  readonly output: (ctx: TCtx, out: UOutput) => TCtx;
}

export const leaf = <TCtx, UInput, UOutput>(
  name: string,
  config: LeafConfig<TCtx, UInput, UOutput>
): Element<TCtx> => ({
  name,
  async execute(ctx, signal, onTrace): Promise<ElementResult<TCtx>> {
    const aborted = checkAborted<TCtx>(name, signal, onTrace);
    if (aborted) return aborted;

    const start = performance.now();
    let result: Result<UOutput, DomainError>;
    try {
      const input = config.input(ctx);
      result = await config.useCase.execute(input, signal);
    } catch (cause) {
      if (!isDomainError(cause)) throw cause;
      const durationMs = performance.now() - start;
      const entry: TraceEntry = { elementName: name, status: 'failed', durationMs, error: cause };
      onTrace?.(entry);
      return Result.error({ error: cause, trace: [entry] });
    }
    const durationMs = performance.now() - start;

    if (signal?.aborted) {
      const error = new AbortError({ elementName: name });
      const entry: TraceEntry = { elementName: name, status: 'aborted', durationMs, error };
      onTrace?.(entry);
      return Result.error({ error, trace: [entry] });
    }

    if (result.ok) {
      let nextCtx: TCtx;
      try {
        nextCtx = config.output(ctx, result.value as UOutput);
      } catch (cause) {
        if (!isDomainError(cause)) throw cause;
        const entry: TraceEntry = { elementName: name, status: 'failed', durationMs, error: cause };
        onTrace?.(entry);
        return Result.error({ error: cause, trace: [entry] });
      }
      const entry: TraceEntry = { elementName: name, status: 'completed', durationMs };
      onTrace?.(entry);
      return Result.ok({ ctx: nextCtx, trace: [entry] });
    }

    const error: DomainError = result.error;
    const entry: TraceEntry = { elementName: name, status: 'failed', durationMs, error };
    onTrace?.(entry);
    return Result.error({ error, trace: [entry] });
  },
});

const isDomainError = (cause: unknown): cause is DomainError =>
  cause instanceof Error && typeof (cause as { code?: unknown }).code === 'string';
