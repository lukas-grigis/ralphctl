import { promises as fs } from 'node:fs';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

const HEADER = '# Sprint Progress\n\n';

/**
 * Ensure `<sprintDir>/progress.md` exists. The implement template instructs the agent to append
 * a learnings entry per task; if the file is missing on first run, this leaf creates it with a
 * one-line header. Idempotent — touching an existing file is a no-op.
 *
 * Why a leaf and not done in `wire()`: the file lives next to the sprint's persisted state and
 * is logically part of the implement run, not the application bootstrap. Doing it as the first
 * leaf in the chain keeps composition root free of harness-specific filesystem layout.
 *
 * The path itself is supplied via the chain factory opts (composition root resolves it from
 * `StoragePaths`); the leaf only deals with materialisation. Carries the path forward on
 * `ctx.progressFile` so per-turn leaves can pass it to `runTaskUseCase`.
 */
export const ensureProgressFileLeaf = (progressFile: AbsolutePath): Element<ImplementCtx> =>
  leaf<ImplementCtx, AbsolutePath, void>('ensure-progress-file', {
    useCase: {
      execute: async (path) => {
        try {
          await fs.access(String(path));
          return Result.ok(undefined) as Result<void, StorageError>;
        } catch {
          // File missing — create it with a header. Any other failure surfaces as StorageError.
        }
        try {
          await fs.writeFile(String(path), HEADER, { flag: 'wx' });
          return Result.ok(undefined) as Result<void, StorageError>;
        } catch (cause) {
          // EEXIST means a concurrent run materialised the file first — treat as success.
          if (typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === 'EEXIST') {
            return Result.ok(undefined) as Result<void, StorageError>;
          }
          return Result.error(
            new StorageError({
              subCode: 'io',
              message: `failed to create progress file: ${String(path)}`,
              path: String(path),
              cause,
            })
          );
        }
      },
    },
    input: () => progressFile,
    output: (ctx) => ({ ...ctx, progressFile }),
  });
