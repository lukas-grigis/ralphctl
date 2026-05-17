import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';

/** Minimum context shape the leaf reads (project id) and writes (loaded project). */
export interface LoadProjectCtx {
  readonly projectId: ProjectId;
  readonly project?: Project;
}

export interface LoadProjectDeps {
  readonly projectRepo: ProjectRepository;
}

/**
 * Reusable leaf that loads a `Project` from the repository and writes it onto `ctx.project`.
 * Generic over `<TCtx extends LoadProjectCtx>` so any chain whose context carries `projectId`
 * can reuse this leaf without sub-typing. The `name` defaults to `'load-project'`; chains that
 * load the project multiple times pass a unique name.
 */
export const loadProjectLeaf = <TCtx extends LoadProjectCtx>(
  deps: LoadProjectDeps,
  name = 'load-project'
): Element<TCtx> =>
  leaf<TCtx, { readonly id: ProjectId }, Project>(name, {
    useCase: {
      execute: async (input) => deps.projectRepo.findById(input.id),
    },
    input: (ctx) => ({ id: ctx.projectId }),
    output: (ctx, project) => ({ ...ctx, project }),
  });
