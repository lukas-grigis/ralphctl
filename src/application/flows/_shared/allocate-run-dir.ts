import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { buildRunDirName } from '@src/integration/ai/runs/_engine/run-artifacts.ts';

/**
 * Generic leaf that materialises a per-run forensic directory at
 * `<runsRoot>/<flow>/<run-id>/` and stashes the absolute path on ctx via the caller-supplied
 * `write` callback.
 *
 * Why a separate leaf: the per-spawn `stamp-session-meta` leaf needs the run directory to
 * exist BEFORE the spawn so `meta.json` can land beside the AI-written `signals.json`. Prior
 * to this leaf, every one-shot AI flow (`readiness`, `detect-skills`, `detect-scripts`)
 * allocated the run dir INSIDE its propose leaf's `execute(...)`, which forced the meta
 * stamp to either inline into the propose leaf (breaking the "single generic stamp leaf"
 * contract) or land after the spawn (defeating the crash-survival rationale). Splitting the
 * allocation into a dedicated leaf is the only seam that makes the chain composition reusable.
 *
 * Idempotent `mkdir -p` semantics — the leaf doesn't error when the directory already
 * exists.
 */
export interface AllocateRunDirOpts<TCtx> {
  /** Step name surfaced in the trace (e.g. `allocate-run-dir-readiness-<tool>`). */
  readonly name: string;
  /** Resolve `<runsRoot>` at execute time. Typically `deps.runsRoot`. */
  readonly runsRoot: (ctx: TCtx) => AbsolutePath;
  /**
   * Flow segment of the path — `readiness` / `detect-skills` / `detect-scripts` / `review`.
   * Becomes the parent of the run-id directory.
   */
  readonly flowSegment: string;
  /** Update ctx with the resolved run-dir path. */
  readonly write: (ctx: TCtx, runDir: AbsolutePath) => TCtx;
}

interface AllocateRunDirInput {
  readonly path: string;
}

export const allocateRunDirLeaf = <TCtx>(opts: AllocateRunDirOpts<TCtx>): Element<TCtx> =>
  leaf<TCtx, AllocateRunDirInput, AbsolutePath>(opts.name, {
    useCase: {
      execute: async (input) => {
        try {
          await fs.mkdir(input.path, { recursive: true });
        } catch (cause) {
          return Result.error(
            new StorageError({
              subCode: 'io',
              message: `failed to create run dir: ${input.path}`,
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
    input: (ctx) => ({ path: join(String(opts.runsRoot(ctx)), opts.flowSegment, buildRunDirName()) }),
    output: (ctx, runDir) => opts.write(ctx, runDir),
  });
