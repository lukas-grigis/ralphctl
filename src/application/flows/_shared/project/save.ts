import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { assertCtxField } from '@src/application/flows/_shared/_engine/assert-ctx-field.ts';

/** Minimum context shape the leaf reads. The project must already be loaded. */
export interface SaveProjectCtx {
  readonly project?: Project;
}

export interface SaveProjectDeps {
  readonly projectRepo: ProjectRepository;
}

/**
 * Reusable leaf that persists `ctx.project`. Generic over `<TCtx extends SaveProjectCtx>` so any
 * chain whose context carries `project` can reuse this leaf. Returns the ctx unchanged on
 * success — saving is a side effect.
 *
 * If `ctx.project` is undefined, the leaf surfaces an `InvalidStateError` rather than silently
 * no-op'ing — this is a chain-construction error (a save leaf was placed before a load leaf).
 */
export const saveProjectLeaf = <TCtx extends SaveProjectCtx>(
  deps: SaveProjectDeps,
  name = 'save-project'
): Element<TCtx> =>
  leaf<TCtx, Project, void>(name, {
    useCase: {
      execute: async (project) => deps.projectRepo.save(project),
    },
    input: (ctx) => assertCtxField(ctx, 'project', name),
    output: (ctx) => ctx,
  });
