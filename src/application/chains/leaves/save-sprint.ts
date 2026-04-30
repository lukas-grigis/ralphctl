/**
 * `saveSprintLeaf` — reusable Leaf factory that persists the
 * `ctx.sprint` aggregate via {@link SprintRepository.save}.
 *
 * Pairs with {@link loadSprintLeaf} — load + mutate (in a leaf above) +
 * save is the canonical chain pattern for any sprint-aggregate edit.
 *
 * Failure modes: the repo surfaces a `StorageError` when persistence
 * misbehaves; the leaf propagates it unchanged so the chain trace shows
 * the `save-sprint` step as failed.
 */
import type { Sprint } from '../../../domain/entities/sprint.ts';
import type { StorageError } from '../../../domain/errors/storage-error.ts';
import type { SprintRepository } from '../../../domain/repositories/sprint-repository.ts';
import type { Result } from '../../../domain/result.ts';
import { Leaf } from '../../../kernel/chain/leaf.ts';
import type { Element } from '../../../kernel/chain/element.ts';

export interface SaveSprintCtx {
  readonly sprint?: Sprint;
}

export interface SaveSprintLeafDeps {
  readonly sprintRepo: SprintRepository;
}

/**
 * Build a save-sprint leaf bound to the given repository. The leaf reads
 * `ctx.sprint` and writes nothing back (success returns `void`).
 *
 * Constructing a leaf without `ctx.sprint` set is a programmer error —
 * the leaf surfaces it as a failed step rather than swallowing.
 */
export function saveSprintLeaf<TCtx extends SaveSprintCtx>(
  deps: SaveSprintLeafDeps,
  name = 'save-sprint'
): Element<TCtx> {
  return new Leaf<TCtx, { readonly sprint: Sprint }, void>(name, {
    useCase: {
      async execute(input): Promise<Result<void, StorageError>> {
        return deps.sprintRepo.save(input.sprint);
      },
    },
    input: (ctx) => {
      if (!ctx.sprint) {
        throw new Error(`Leaf '${name}' requires ctx.sprint to be set`);
      }
      return { sprint: ctx.sprint };
    },
    output: (ctx) => ctx,
  });
}
