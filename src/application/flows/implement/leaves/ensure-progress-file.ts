import { Result } from '@src/domain/result.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { LoadChainLog } from '@src/business/sprint/load-chain-log.ts';
import { writeProgressSnapshot } from '@src/business/sprint/write-progress-snapshot.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Render the initial `<sprintDir>/progress.md` snapshot at the start of the implement chain.
 *
 * Replaces the streaming-sink era of progress.md — the file is now a function of the persisted
 * entities + `chain.log`, regenerated from scratch at every well-defined moment (sprint start,
 * settle-attempt, sprint transition). See {@link writeProgressSnapshot} for the policy.
 *
 * Why a leaf and not a static stub: at sprint start the freshly-activated sprint already has
 * its identity, branch, ticket list, and tasks — the first snapshot SHOULD reflect that state,
 * not an empty placeholder. A fresh agent reading `progress.md` immediately gets the
 * activated-sprint context.
 *
 * Carries the path forward on `ctx.progressFile` so per-turn leaves (`generator` / `evaluator`)
 * can pass it to the AI session.
 */

export interface EnsureProgressFileLeafDeps {
  readonly loadChainLog: LoadChainLog;
  readonly writeFile: WriteFile;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
}

interface LeafInput {
  readonly sprint: ImplementCtx['sprint'];
  readonly execution: ImplementCtx['execution'];
  readonly tasks: ImplementCtx['tasks'];
  readonly progressFile: AbsolutePath;
  readonly chainLogPath: AbsolutePath;
}

export const ensureProgressFileLeaf = (
  deps: EnsureProgressFileLeafDeps,
  progressFile: AbsolutePath,
  chainLogPath: AbsolutePath
): Element<ImplementCtx> =>
  leaf<ImplementCtx, LeafInput, void>('ensure-progress-file', {
    useCase: {
      execute: async (input) => {
        if (input.sprint === undefined || input.execution === undefined || input.tasks === undefined) {
          // The chain composes load-sprint → activate-sprint → load-execution → load-tasks BEFORE
          // this leaf; reaching here without those is a programmer error in the chain factory.
          return Result.error(
            new InvalidStateError({
              entity: 'chain',
              currentState: 'pre-ensure-progress-file',
              attemptedAction: 'ensure-progress-file',
              message:
                'ensure-progress-file: ctx missing sprint/execution/tasks — load-sprint, activate-sprint, load-execution, load-tasks must run first',
            })
          ) as Result<void, StorageError | InvalidStateError>;
        }
        return writeProgressSnapshot(
          { loadChainLog: deps.loadChainLog, writeFile: deps.writeFile, clock: deps.clock, logger: deps.logger },
          {
            sprint: input.sprint,
            execution: input.execution,
            tasks: input.tasks,
            chainLogPath: input.chainLogPath,
            progressFile: input.progressFile,
          }
        ) as Promise<Result<void, StorageError | InvalidStateError>>;
      },
    },
    input: (ctx) => ({
      sprint: ctx.sprint,
      execution: ctx.execution,
      tasks: ctx.tasks,
      progressFile,
      chainLogPath,
    }),
    output: (ctx) => ({ ...ctx, progressFile }),
  });
