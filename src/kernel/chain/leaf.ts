import { Result } from 'typescript-result';

import type { ElementResult, KernelError, OnTraceCallback } from './element.ts';
import { Element } from './element.ts';

/**
 * Use case shape the {@link Leaf} adapts. The kernel deliberately knows
 * nothing about ralphctl-specific use cases — anything matching this shape
 * (a single async method returning a `Result`) plugs in.
 */
export interface LeafUseCase<UInput, UOutput> {
  execute(input: UInput, signal?: AbortSignal): Promise<Result<UOutput, KernelError>>;
}

/** Configuration for a {@link Leaf}. */
export interface LeafConfig<TCtx, UInput, UOutput> {
  readonly useCase: LeafUseCase<UInput, UOutput>;
  /** Project the chain context down to the use case's input. */
  readonly input: (ctx: TCtx) => UInput;
  /** Merge the use case's output back into a new context. */
  readonly output: (ctx: TCtx, out: UOutput) => TCtx;
}

/**
 * The seam between the chain framework and business use cases.
 *
 * `Leaf` is the only element that calls a use case. It maps `ctx → input`,
 * invokes `useCase.execute(input)`, then maps `(ctx, output) → newCtx`.
 *
 * On failure the use case's error propagates unchanged. On success the new
 * context replaces the old one.
 */
export class Leaf<TCtx, UInput, UOutput> extends Element<TCtx> {
  private readonly config: LeafConfig<TCtx, UInput, UOutput>;

  constructor(name: string, config: LeafConfig<TCtx, UInput, UOutput>) {
    super(name);
    this.config = config;
  }

  protected override run(ctx: TCtx, signal?: AbortSignal, onTrace?: OnTraceCallback): Promise<ElementResult<TCtx>> {
    return this.runLeaf(
      async () => {
        const input = this.config.input(ctx);
        const result = await this.config.useCase.execute(input, signal);
        if (!result.ok) {
          return Result.error(result.error);
        }
        const output = result.value as UOutput;
        return Result.ok(this.config.output(ctx, output)) as Result<TCtx, KernelError>;
      },
      signal,
      onTrace
    );
  }
}
