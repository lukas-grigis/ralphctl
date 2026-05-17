import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';

/**
 * Generic leaf that materialises a per-item directory under a parent. Used by interactive
 * chains (refine, plan-interactive) to create a stable per-ticket / per-task location for
 * `prompt.md` (input) and the AI's output file. `mkdir -p` semantics — already-existing
 * directories are not an error.
 *
 * Why a leaf and not done in the surrounding chain factory: each per-item sub-chain runs
 * lazily during `runner.start()`. Materialising the dir at construction time would create
 * directories before the user has even confirmed they want to start the run.
 *
 * Ctx contract: the caller supplies `parent`, `slug`, and `write` callbacks. The leaf doesn't
 * assume any particular ctx shape; flows pass closures that touch their own scratch fields.
 */
export interface BuildUnitOpts<TCtx> {
  /** Step name surfaced in the trace (e.g. `build-refine-unit-<ticket-id>`). */
  readonly name: string;
  /** Resolve the parent directory at execute time. Typically `<sprintDir>/<flow>/`. */
  readonly parent: (ctx: TCtx) => AbsolutePath;
  /** Resolve the sub-folder name. URL-safe; the caller is responsible for slug sanitisation. */
  readonly slug: (ctx: TCtx) => string;
  /** Update ctx with the resolved unit-root path. Caller decides which ctx field to set. */
  readonly write: (ctx: TCtx, root: AbsolutePath) => TCtx;
}

export const buildUnitLeaf = <TCtx>(opts: BuildUnitOpts<TCtx>): Element<TCtx> =>
  leaf<TCtx, { readonly path: string }, AbsolutePath>(opts.name, {
    useCase: {
      execute: async (input) => {
        try {
          await fs.mkdir(input.path, { recursive: true });
        } catch (cause) {
          return Result.error(
            new StorageError({
              subCode: 'io',
              message: `failed to create unit directory: ${input.path}`,
              path: input.path,
              cause,
            })
          );
        }
        const parsed = AbsolutePath.parse(input.path);
        if (!parsed.ok) return Result.error(parsed.error as never);
        return Result.ok(parsed.value);
      },
    },
    input: (ctx) => ({ path: join(String(opts.parent(ctx)), opts.slug(ctx)) }),
    output: (ctx, root) => opts.write(ctx, root),
  });
