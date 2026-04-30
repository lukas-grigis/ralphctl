/**
 * `loadSprintLeaf` — reusable Leaf factory that loads a `Sprint` by id from
 * the {@link SprintRepository} and writes it onto the chain context.
 *
 * The leaf is the seam between the chain framework and the persistence
 * port: it adapts the repo's `findById` signature into the
 * {@link LeafUseCase} shape the kernel speaks.
 *
 * Used by every chain that needs a sprint — refine, plan, ideate, execute,
 * evaluate, feedback. Keep it dumb on purpose; sprint-status guards belong
 * in their own leaves so the trace shows them as distinct steps.
 */
import type { Sprint } from '../../../domain/entities/sprint.ts';
import type { NotFoundError } from '../../../domain/errors/not-found-error.ts';
import type { StorageError } from '../../../domain/errors/storage-error.ts';
import type { SprintRepository } from '../../../domain/repositories/sprint-repository.ts';
import type { Result } from '../../../domain/result.ts';
import type { SprintId } from '../../../domain/values/sprint-id.ts';
import { Leaf } from '../../../kernel/chain/leaf.ts';
import type { Element } from '../../../kernel/chain/element.ts';

/** Minimum context shape the leaf reads/writes. */
export interface LoadSprintCtx {
  readonly sprintId: SprintId;
  readonly sprint?: Sprint;
}

export interface LoadSprintLeafDeps {
  readonly sprintRepo: SprintRepository;
}

/**
 * Build a load-sprint leaf bound to the given repository. The leaf reads
 * `ctx.sprintId`, fetches the sprint, and writes it onto `ctx.sprint`.
 */
export function loadSprintLeaf<TCtx extends LoadSprintCtx>(
  deps: LoadSprintLeafDeps,
  name = 'load-sprint'
): Element<TCtx> {
  return new Leaf<TCtx, { readonly id: SprintId }, Sprint>(name, {
    useCase: {
      async execute(input): Promise<Result<Sprint, NotFoundError | StorageError>> {
        return deps.sprintRepo.findById(input.id);
      },
    },
    input: (ctx) => ({ id: ctx.sprintId }),
    output: (ctx, sprint) => ({ ...ctx, sprint }),
  });
}
