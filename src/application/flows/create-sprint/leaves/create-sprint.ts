import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { createSprintUseCase, type CreateSprintOutput } from '@src/business/sprint/create-sprint.ts';
import type { CreateSprintCtx } from '@src/application/flows/create-sprint/ctx.ts';

export interface CreateSprintLeafDeps {
  readonly logger: Logger;
}

interface LeafInput {
  readonly projectId: ProjectId;
  readonly name: string;
}

/**
 * Per-flow leaf wrapping `createSprintUseCase`. Reads the values the interactive leaf wrote onto
 * the ctx, calls the use case, and writes `sprint` + `execution` back so the downstream save
 * leaves can persist them.
 *
 * The use case is synchronous and pure; the leaf's `execute` adapts it to the async `LeafUseCase`
 * shape by wrapping the synchronous result in `Promise.resolve`.
 */
export const createSprintLeaf = (deps: CreateSprintLeafDeps): Element<CreateSprintCtx> =>
  leaf<CreateSprintCtx, LeafInput, CreateSprintOutput>('create-sprint', {
    useCase: {
      execute: async (input) =>
        Promise.resolve(
          createSprintUseCase({
            projectId: input.projectId,
            name: input.name,
            logger: deps.logger,
          })
        ),
    },
    input: (ctx) => {
      if (ctx.sprintName === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-create',
          attemptedAction: 'create-sprint',
          message: 'create-sprint: ctx.sprintName is undefined — interactive-sprint-name must run first',
        });
      }
      return {
        projectId: ctx.projectId,
        name: ctx.sprintName,
      };
    },
    output: (ctx, out) => ({ ...ctx, sprint: out.sprint, execution: out.execution }),
  });
