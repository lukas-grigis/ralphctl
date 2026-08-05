import { Result } from '@src/domain/result.ts';
import type { InProgressTask } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { ImplementDeps } from '@src/application/flows/implement/deps.ts';

/** Shared with `best-of-n-candidate.ts` — same logger namespace as the rest of the candidate loop. */
const BEST_OF_N_CANDIDATE_LOGGER = 'implement.best-of-n.candidate';

/**
 * Persist the grant's consumption to disk BEFORE any candidate spawns — the once-per-attempt
 * spend the whole opt-in remedy costs must survive a crash mid-sampling, not just a clean finish.
 * `bestOfNSelectionLeaf`'s `consumeGrant` (best-of-n-selection.ts) clears the SAME
 * `bestOfNGrantedCandidates` field on ctx once selection closes out — but that ctx mutation only
 * reaches disk via whatever leaf persists next (`finalize-gen-eval`, downstream of the WHOLE
 * best-of-N composite, potentially several turns later). A process death anywhere before that —
 * mid candidate-1 spawn, mid judge tournament — would leave `bestOfNGrantedCandidates` on disk, so
 * a relaunch re-grants N more sessions on top of the ones already spent.
 *
 * Deliberately a DISK-ONLY side effect: `ctx.currentTask` keeps the field for the rest of this
 * attempt (the leaf's `output` is the identity projection). `attempt-body.ts`'s outer branch
 * guards don't read this field after entry anyway (see `best-of-n.ts`'s `hasBestOfNCompositeRun`
 * docstring), and the candidate/selection leaves key off `ctx.bestOfNLoopTurn` /
 * `ctx.bestOfNSampledCount`, not `bestOfNGrantedCandidates` — so clearing it in-memory here would
 * buy nothing and risks reintroducing the exact outer-guard hazard that field's ctx-level clearing
 * already causes downstream in `bestOfNSelectionLeaf`.
 *
 * Best-effort: a write failure is logged and the loop proceeds anyway — the worst case is the
 * pre-existing crash-window risk this leaf exists to shrink, never a new blocking failure.
 *
 * Sequenced by `best-of-n.ts`'s `buildRound1Substitute` ahead of `bestOfNCandidateLoopLeaf` — it
 * must run exactly ONCE, before candidate 1, not once per loop iteration.
 */
export const persistBestOfNGrantConsumedLeaf = (deps: ImplementDeps, taskId: TaskId): Element<ImplementCtx> =>
  leaf<ImplementCtx, { readonly sprintId: SprintId; readonly task: InProgressTask }, void>(
    `best-of-n-persist-grant-consumed-${String(taskId)}`,
    {
      useCase: {
        execute: async (input) => {
          const { bestOfNGrantedCandidates: _drop, ...rest } = input.task;
          void _drop;
          const saved = await deps.taskRepo.update(input.sprintId, rest);
          if (!saved.ok) {
            deps.logger
              .named(BEST_OF_N_CANDIDATE_LOGGER)
              .warn(
                `best-of-n: failed to persist grant consumption before sampling for task '${String(taskId)}' — a crash during sampling could re-grant on relaunch`,
                { taskId: String(taskId), error: saved.error.message }
              );
          }
          return Result.ok(undefined);
        },
      },
      input: (ctx) => {
        if (
          ctx.currentTask === undefined ||
          ctx.currentTask.id !== taskId ||
          ctx.currentTask.status !== 'in_progress'
        ) {
          throw new InvalidStateError({
            entity: 'chain',
            currentState: 'pre-best-of-n-persist-grant-consumed',
            attemptedAction: `best-of-n-persist-grant-consumed-${String(taskId)}`,
            message: `best-of-n-persist-grant-consumed-${String(taskId)}: ctx.currentTask missing, mismatched, or not in_progress`,
          });
        }
        return { sprintId: ctx.sprintId, task: ctx.currentTask };
      },
      // Disk-only side effect — ctx is returned unchanged, see the docstring above.
      output: (ctx) => ctx,
    }
  );
