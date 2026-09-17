import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { FindTasksBySprintId } from '@src/domain/repository/task/find-tasks-by-sprint-id.ts';
import type { Logger } from '@src/business/observability/logger.ts';

import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { adoptPersistedBlocks } from '@src/application/flows/implement/merge-wave.ts';

/**
 * First leaf of the PARALLEL implement epilogue (`buildParallelImplementEpilogue`, `flow.ts`) —
 * never spliced into the serial tree, which has no analogous gap to close (see `mergeImplementWave`
 * for why the parallel fan-in has one).
 *
 * Re-reads `tasks.json` and, for every in-memory task still `todo`/`in_progress`, substitutes the
 * persisted row whenever that row is `blocked` — recovering a block (and, for a quarantined diff,
 * its stash pointer) a non-`completed` branch already wrote to disk before `mergeImplementWave`
 * dropped its ctx on the floor. Runs BEFORE `saveTasksLeaf` so that leaf's whole-list write never
 * clobbers the very block this leaf just pulled back, and before the review-transition guard so it
 * sees the reconciled set too.
 *
 * Never fails the epilogue — this read is a best-effort reconciliation, not a precondition, and the
 * epilogue's whole point (THE B4 durability gate) is to persist whatever the run produced even on
 * an abort / fatal path:
 *  - `ctx.tasks` undefined (e.g. the prologue failed before `load-tasks` ran) → no-op, no read.
 *  - the read `Result.error`s (a `StorageError`) → warn and keep `ctx.tasks` unchanged.
 *  - the port THROWS a non-`AbortError` (an adapter blowing up) → warn and keep `ctx.tasks`
 *    unchanged.
 *  - the port throws `AbortError` → propagates verbatim (the one exempt case — an in-flight abort
 *    must never be swallowed as a mere read failure).
 *
 * @public
 */
export interface AdoptPersistedBlocksLeafDeps {
  readonly taskRepo: FindTasksBySprintId;
  readonly logger: Logger;
}

interface AdoptPersistedBlocksInput {
  readonly sprintId: SprintId;
  readonly tasks: readonly Task[] | undefined;
}

interface AdoptPersistedBlocksOutput {
  readonly tasks: readonly Task[] | undefined;
}

export const adoptPersistedBlocksLeaf = (deps: AdoptPersistedBlocksLeafDeps): Element<ImplementCtx> =>
  leaf<ImplementCtx, AdoptPersistedBlocksInput, AdoptPersistedBlocksOutput>(
    'adopt-persisted-blocks',
    {
      useCase: {
        execute: async (input): Promise<Result<AdoptPersistedBlocksOutput, DomainError>> => {
          if (input.tasks === undefined) return Result.ok({ tasks: undefined });

          const named = deps.logger.named('implement.adopt-persisted-blocks');
          let persisted;
          try {
            persisted = await deps.taskRepo.findBySprintId(input.sprintId);
          } catch (cause) {
            if (cause instanceof AbortError) throw cause;
            named.warn('task read threw — epilogue proceeds with the in-memory task list', {
              sprintId: String(input.sprintId),
              error: cause instanceof Error ? cause.message : String(cause),
            });
            return Result.ok({ tasks: input.tasks });
          }
          if (!persisted.ok) {
            named.warn('task read failed — epilogue proceeds with the in-memory task list', {
              sprintId: String(input.sprintId),
              error: persisted.error.message,
            });
            return Result.ok({ tasks: input.tasks });
          }
          return Result.ok({ tasks: adoptPersistedBlocks(input.tasks, persisted.value) });
        },
      },
      input: (ctx) => ({ sprintId: ctx.sprintId, tasks: ctx.tasks }),
      output: (ctx, out) => (out.tasks === ctx.tasks ? ctx : { ...ctx, tasks: out.tasks }),
    },
    { label: 'reconcile persisted blocks' }
  );
