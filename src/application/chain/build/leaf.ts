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

export interface LeafOpts {
  /**
   * Optional human-friendly display label forwarded to the resulting `Element` and every
   * `TraceEntry` the leaf emits. The element `name` stays the canonical identifier; UI
   * surfaces (e.g. the Execute-view rail) render `label` when present. Use this when flow
   * authors need to disambiguate element names with structural data (e.g. a repo path)
   * without leaking that data into the rendered label.
   */
  readonly label?: string;
}

export const leaf = <TCtx, UInput, UOutput>(
  name: string,
  config: LeafConfig<TCtx, UInput, UOutput>,
  opts?: LeafOpts
): Element<TCtx> => {
  // Build the optional label-bearing extension once; spreading it into each TraceEntry keeps the
  // `label` key absent when the caller didn't supply one (preserves exact-equality test snapshots
  // and the existing `label?: string` shape).
  const labelExt: { readonly label?: string } = opts?.label !== undefined ? { label: opts.label } : {};
  return {
    name,
    ...labelExt,
    async execute(ctx, signal, onTrace): Promise<ElementResult<TCtx>> {
      const aborted = checkAborted<TCtx>(name, signal, onTrace);
      if (aborted) return aborted;

      const start = performance.now();

      // Single place that builds + emits a trace entry. The `error` key is spread conditionally so a
      // `completed` entry has no `error` property at all (callers do exact-equality comparisons).
      const record = (status: TraceEntry['status'], durationMs: number, error?: DomainError): TraceEntry => {
        const entry: TraceEntry = {
          elementName: name,
          ...labelExt,
          status,
          durationMs,
          ...(error !== undefined ? { error } : {}),
        };
        onTrace?.(entry);
        return entry;
      };

      let result: Result<UOutput, DomainError>;
      try {
        const input = config.input(ctx);
        result = await config.useCase.execute(input, signal);
      } catch (cause) {
        if (!isDomainError(cause)) throw cause;
        const status = cause instanceof AbortError ? 'aborted' : 'failed';
        return Result.error({ error: cause, trace: [record(status, performance.now() - start, cause)] });
      }
      const durationMs = performance.now() - start;

      if (signal?.aborted) {
        const error = new AbortError({ elementName: name });
        return Result.error({ error, trace: [record('aborted', durationMs, error)] });
      }

      if (result.ok) {
        let nextCtx: TCtx;
        try {
          nextCtx = config.output(ctx, result.value as UOutput);
        } catch (cause) {
          if (!isDomainError(cause)) throw cause;
          return Result.error({ error: cause, trace: [record('failed', durationMs, cause)] });
        }
        return Result.ok({ ctx: nextCtx, trace: [record('completed', durationMs)] });
      }

      const error: DomainError = result.error;
      return Result.error({ error, trace: [record('failed', durationMs, error)] });
    },
  };
};

const isDomainError = (cause: unknown): cause is DomainError =>
  cause instanceof Error && typeof (cause as { code?: unknown }).code === 'string';
