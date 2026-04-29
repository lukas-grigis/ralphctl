import type { StepContext } from '@src/domain/context.ts';
import type { DomainResult } from '@src/domain/types.ts';
import { Result } from '@src/domain/types.ts';
import { DomainError, ParseError, SkillNameCollisionError } from '@src/domain/errors.ts';
import type { LoggerPort } from '@src/business/ports/logger.ts';
import type { LinkedSkillSet, SkillPhase, SkillsPort } from '@src/business/ports/skills.ts';
import { step } from '@src/business/pipelines/framework/helpers.ts';
import type { PipelineStep } from '@src/business/pipelines/framework/types.ts';

/**
 * Context fragment a pipeline must thread through to use the skill lifecycle
 * steps. Pipelines extend their own context with `linkedSkillSets` so the
 * cleanup step can drain exactly what `link` created — no global state, no
 * cross-pipeline leakage when several pipelines run concurrently.
 */
export interface WithLinkedSkills {
  /** Sets created by `link-skills`, drained by `cleanup-skills`. */
  linkedSkillSets?: LinkedSkillSet[];
}

/**
 * Build the `link-skills` step.
 *
 * `getWorkingDirs(ctx)` returns the absolute paths each AI session in this
 * phase will spawn into. The step:
 *   1. Loads skills via `skills.loadForPhase(phase)`. A name collision throws
 *      `SkillNameCollisionError` here, before any AI session is launched, so
 *      the phase aborts cleanly with both source paths in the error.
 *   2. Calls `skills.link(...)` for each working directory. Failures inside
 *      a single link call (e.g. permission errors on individual symlinks)
 *      are logged via the adapter and excluded from the returned set; the
 *      step itself only fails if `loadForPhase` or the underlying mkdir
 *      throws an unexpected error.
 *   3. Pushes the resulting `LinkedSkillSet[]` into context for the cleanup
 *      step to drain.
 *
 * No-ops when `getWorkingDirs(ctx)` returns an empty list — a phase with
 * nothing to link still runs, the cleanup step then has nothing to do.
 */
export function linkSkillsStep<TCtx extends StepContext & WithLinkedSkills>(
  skills: SkillsPort,
  phase: SkillPhase,
  getWorkingDirs: (ctx: TCtx) => readonly string[] | Promise<readonly string[]>
): PipelineStep<TCtx> {
  return step<TCtx>('link-skills', async (ctx): Promise<DomainResult<Partial<TCtx>>> => {
    // Resolve skills FIRST so the (potentially expensive) working-dir
    // computation is skipped when there is nothing to link. This also keeps
    // the test surface narrow — a phase with no skills doesn't need its
    // pipeline's working-dir resolver to be wired.
    let resolvedSkills;
    try {
      resolvedSkills = await skills.loadForPhase(phase);
    } catch (err) {
      if (err instanceof SkillNameCollisionError) return Result.error(err);
      if (err instanceof DomainError) return Result.error(err);
      return Result.error(new ParseError(`Skill load failed: ${err instanceof Error ? err.message : String(err)}`));
    }

    if (resolvedSkills.length === 0) {
      const empty = { linkedSkillSets: [] } as unknown as Partial<TCtx>;
      return Result.ok(empty) as DomainResult<Partial<TCtx>>;
    }

    const workingDirs = await getWorkingDirs(ctx);
    if (workingDirs.length === 0) {
      const empty = { linkedSkillSets: [] } as unknown as Partial<TCtx>;
      return Result.ok(empty) as DomainResult<Partial<TCtx>>;
    }

    const sets: LinkedSkillSet[] = [];
    for (const workingDir of workingDirs) {
      try {
        const set = await skills.link(workingDir, resolvedSkills);
        sets.push(set);
      } catch (err) {
        // The adapter logs per-skill warnings; an unexpected throw is the
        // mkdir/symlink boundary failing wholesale (e.g. EROFS on the
        // working tree). Treat as a hard step failure so the phase aborts
        // before AI spawn — running without skills is a silent contract
        // violation a downstream step won't notice.
        if (err instanceof DomainError) return Result.error(err);
        return Result.error(
          new ParseError(`Skill link failed for ${workingDir}: ${err instanceof Error ? err.message : String(err)}`)
        );
      }
    }

    const partial = { linkedSkillSets: sets } as unknown as Partial<TCtx>;
    return Result.ok(partial) as DomainResult<Partial<TCtx>>;
  });
}

/**
 * Build the `cleanup-skills` step.
 *
 * Drains every set in `ctx.linkedSkillSets`. Cleanup is best-effort — a
 * failure on one set is logged but does not prevent the others from being
 * cleaned. The step always succeeds so its presence at the tail of a
 * pipeline never converts a successful AI run into a failure.
 *
 * Symlinks are also reaped on `process.exit` by the lifecycle module's
 * registry, so an interrupt that bypasses this step still leaves the
 * working trees clean. This step is the deterministic happy-path drain.
 */
export function cleanupSkillsStep<TCtx extends StepContext & WithLinkedSkills>(
  skills: SkillsPort,
  logger?: LoggerPort
): PipelineStep<TCtx> {
  return step<TCtx>('cleanup-skills', async (ctx): Promise<DomainResult<Partial<TCtx>>> => {
    const sets = ctx.linkedSkillSets ?? [];
    for (const set of sets) {
      try {
        await skills.cleanup(set);
      } catch (err) {
        logger?.warning(
          `Failed to clean up linked skills in ${set.workingDir}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    const partial = { linkedSkillSets: [] } as unknown as Partial<TCtx>;
    return Result.ok(partial) as DomainResult<Partial<TCtx>>;
  });
}
