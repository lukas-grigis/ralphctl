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
import type { LoadDecisionsLog } from '@src/business/sprint/load-decisions-log.ts';
import { writeProgressSnapshot } from '@src/business/sprint/write-progress-snapshot.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Snapshot leaf — regenerates `<sprintDir>/progress.md` from the current ctx state.
 *
 * Placed at the two non-initial trigger points the snapshot renderer cares about:
 *  - immediately AFTER every per-task `settle-attempt` so the file reflects the just-settled
 *    task transition,
 *  - immediately AFTER `transition-sprint-to-review` so the file shows the sprint moved into
 *    review.
 *
 * Best-effort by contract — a failure here is logged and swallowed. The canonical state lives
 * in `tasks.json` and the chain.log NDJSON; `progress.md` is a derived artefact. Blocking the
 * chain on a refresh failure would be worse than letting the next snapshot regeneration heal
 * the file.
 *
 * The leaf name is parameterised so multiple snapshot points within the same chain still
 * produce distinct trace entries (`progress-snapshot-after-settle-<taskId>`,
 * `progress-snapshot-after-review`, …).
 */

export interface WriteProgressSnapshotLeafDeps {
  readonly loadChainLog: LoadChainLog;
  readonly loadDecisionsLog: LoadDecisionsLog;
  readonly writeFile: WriteFile;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
}

export interface WriteProgressSnapshotLeafOpts {
  readonly progressFile: AbsolutePath;
  readonly chainLogPath: AbsolutePath;
  readonly decisionsLogPath: AbsolutePath;
  readonly name: string;
}

interface LeafInput {
  readonly sprint: ImplementCtx['sprint'];
  readonly execution: ImplementCtx['execution'];
  readonly tasks: ImplementCtx['tasks'];
}

export const writeProgressSnapshotLeaf = (
  deps: WriteProgressSnapshotLeafDeps,
  opts: WriteProgressSnapshotLeafOpts
): Element<ImplementCtx> =>
  leaf<ImplementCtx, LeafInput, void>(opts.name, {
    useCase: {
      execute: async (input) => {
        if (input.sprint === undefined || input.execution === undefined || input.tasks === undefined) {
          return Result.error(
            new InvalidStateError({
              entity: 'chain',
              currentState: 'pre-progress-snapshot',
              attemptedAction: opts.name,
              message: `${opts.name}: ctx missing sprint/execution/tasks — upstream load leaves must run first`,
            })
          ) as Result<void, StorageError | InvalidStateError>;
        }
        const result = await writeProgressSnapshot(
          {
            loadChainLog: deps.loadChainLog,
            loadDecisionsLog: deps.loadDecisionsLog,
            writeFile: deps.writeFile,
            clock: deps.clock,
            logger: deps.logger,
          },
          {
            sprint: input.sprint,
            execution: input.execution,
            tasks: input.tasks,
            chainLogPath: opts.chainLogPath,
            decisionsLogPath: opts.decisionsLogPath,
            progressFile: opts.progressFile,
          }
        );
        // Best-effort: log the failure but pass the chain through. The next trigger-point
        // snapshot will overwrite the (potentially stale) file.
        if (!result.ok) {
          deps.logger
            .named('implement.progress-snapshot')
            .warn(`${opts.name} write failed`, { error: result.error.message });
        }
        return Result.ok(undefined) as Result<void, StorageError | InvalidStateError>;
      },
    },
    input: (ctx) => ({ sprint: ctx.sprint, execution: ctx.execution, tasks: ctx.tasks }),
    output: (ctx) => ctx,
  });
