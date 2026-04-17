import type { StepContext } from '@src/domain/context.ts';
import type { Config } from '@src/domain/models.ts';
import { Result } from '@src/domain/types.ts';
import type { DomainResult } from '@src/domain/types.ts';
import { DomainError, StorageError } from '@src/domain/errors.ts';
import type { PersistencePort } from '@src/domain/repositories/persistence.ts';
import { step } from '@src/business/pipeline/helpers.ts';
import type { PipelineStep } from '@src/business/pipeline/types.ts';

/**
 * Read the global config fresh from persistence into `ctx.config`.
 *
 * **Critical — always live-read.** This step never captures the persistence
 * handle at construction time and never caches the resulting config. The
 * CLAUDE.md "live config" (REQ-12) constraint requires mid-execution edits
 * via the settings panel to take effect on the next pipeline iteration
 * without a restart, so steps that read `ctx.config` should only rely on
 * values resolved by a just-ran `resolve-config` step.
 */
export function resolveConfigStep<TCtx extends StepContext & { config?: Config }>(
  persistence: PersistencePort
): PipelineStep<TCtx> {
  return step<TCtx>('resolve-config', async (): Promise<DomainResult<Partial<TCtx>>> => {
    try {
      const config = await persistence.getConfig();
      const partial: Partial<TCtx> = { config } as Partial<TCtx>;
      return Result.ok(partial) as DomainResult<Partial<TCtx>>;
    } catch (err) {
      if (err instanceof DomainError) return Result.error(err);
      return Result.error(
        new StorageError(
          `Failed to load config: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err : undefined
        )
      );
    }
  });
}
