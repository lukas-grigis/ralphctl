import { Result } from '@src/domain/result.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';

/**
 * Generic leaf that builds a prompt and writes the rendered text to disk. Interactive AI
 * sessions (refine, plan-interactive) pass the resulting file path to the AI as the prompt
 * input — interactive coding-assistant CLIs prefer file inputs over giant CLI args.
 *
 * Ctx contract: caller supplies `path`, `buildPrompt`, and `write` callbacks. Build-prompt
 * runs first; on success the rendered text is written atomically via {@link WriteFile}.
 */
export interface RenderPromptToFileDeps {
  readonly writeFile: WriteFile;
}

export interface RenderPromptToFileOpts<TCtx> {
  /** Step name surfaced in the trace (e.g. `render-prompt-to-file-<ticket-id>`). */
  readonly name: string;
  /** Resolve the target path at execute time. Typically `<unit-root>/prompt.md`. */
  readonly path: (ctx: TCtx) => AbsolutePath;
  /** Construct the typed prompt from ctx. Errors propagate; the leaf does not retry. */
  readonly buildPrompt: (ctx: TCtx) => Promise<Result<Prompt, DomainError>>;
  /** Update ctx with the resolved prompt-file path. */
  readonly write: (ctx: TCtx, path: AbsolutePath) => TCtx;
}

export const renderPromptToFileLeaf = <TCtx>(
  deps: RenderPromptToFileDeps,
  opts: RenderPromptToFileOpts<TCtx>
): Element<TCtx> =>
  leaf<TCtx, { readonly ctx: TCtx; readonly path: AbsolutePath }, AbsolutePath>(opts.name, {
    useCase: {
      execute: async (input) => {
        const built = await opts.buildPrompt(input.ctx);
        if (!built.ok) return Result.error(built.error);
        const wrote = await deps.writeFile(input.path, String(built.value));
        if (!wrote.ok) return Result.error(wrote.error);
        return Result.ok(input.path);
      },
    },
    input: (ctx) => ({ ctx, path: opts.path(ctx) }),
    output: (ctx, path) => opts.write(ctx, path),
  });
