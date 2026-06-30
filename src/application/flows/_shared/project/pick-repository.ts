import { Result } from '@src/domain/result.ts';
import type { Choice, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';

/** Leaf name, reused as the `attemptedAction` on the leaf's error states. */
const LEAF_NAME = 'pick-repository';

/**
 * Minimum context shape the leaf reads (`project`, loaded by `loadProjectLeaf`) and writes
 * (`repository`). Generic over `<TCtx extends PickRepositoryCtx>` so each flow can plug its
 * own context shape in.
 */
export interface PickRepositoryCtx {
  readonly project?: Project;
  readonly repository?: Repository;
}

export interface PickRepositoryLeafDeps {
  readonly interactive: InteractivePrompt;
}

/**
 * Per-flow configuration. `promptMessage` and `emptyVerb` are required so the prompt and the
 * empty-project error read naturally for each caller; `preselectedFromCtx` is optional for
 * flows whose context carries a pre-selected `repositoryId` (e.g. when the launcher invoked
 * the flow from a repository row on the project-detail view).
 */
export interface PickRepositoryLeafConfig<TCtx extends PickRepositoryCtx> {
  readonly promptMessage: string;
  /** Verb phrase used in the "project '...' has no repositories to ${verb}" error. */
  readonly emptyVerb: string;
  readonly preselectedFromCtx?: (ctx: TCtx) => RepositoryId | undefined;
}

interface PickRepositoryInput {
  readonly project: Project;
  readonly repositoryId?: RepositoryId;
}

/**
 * Pick which repository the chain operates on. Three branches:
 *  - `repositoryId` was pre-selected by the launcher → resolve against the project; fail with
 *    `NotFoundError` if it doesn't belong to this project.
 *  - The project has exactly one repository → auto-select it.
 *  - Otherwise → interactive single-select via `deps.interactive.askChoice`.
 *
 * Cancellation surfaces as the underlying `askChoice` error (typically `AbortError`).
 */
const pickRepositoryUseCase = async (
  deps: PickRepositoryLeafDeps,
  input: PickRepositoryInput,
  promptMessage: string,
  emptyVerb: string
): Promise<Result<Repository, DomainError>> => {
  const repos = input.project.repositories;
  if (repos.length === 0) {
    return Result.error(
      new InvalidStateError({
        entity: 'project',
        currentState: 'no-repositories',
        attemptedAction: LEAF_NAME,
        message: `project '${input.project.slug}' has no repositories to ${emptyVerb}`,
      })
    );
  }

  if (input.repositoryId !== undefined) {
    const match = repos.find((r) => r.id === input.repositoryId);
    if (!match) {
      return Result.error(
        new NotFoundError({
          entity: 'repository',
          id: String(input.repositoryId),
          message: `repository '${String(input.repositoryId)}' is not on project '${input.project.slug}'`,
        })
      );
    }
    return Result.ok(match);
  }

  if (repos.length === 1) return Result.ok(repos[0]!);

  const choices: ReadonlyArray<Choice<Repository>> = repos.map((r) => ({
    label: `${r.name} (${String(r.slug)})`,
    value: r,
    description: String(r.path),
  }));

  return deps.interactive.askChoice(promptMessage, choices);
};

export const pickRepositoryLeaf = <TCtx extends PickRepositoryCtx>(
  deps: PickRepositoryLeafDeps,
  config: PickRepositoryLeafConfig<TCtx>
): Element<TCtx> =>
  leaf<TCtx, PickRepositoryInput, Repository>(LEAF_NAME, {
    useCase: {
      execute: async (input) => pickRepositoryUseCase(deps, input, config.promptMessage, config.emptyVerb),
    },
    input: (ctx) => {
      if (ctx.project === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-pick-repository',
          attemptedAction: LEAF_NAME,
          message: 'pick-repository: ctx.project is undefined — load-project must run first',
        });
      }
      const preselected = config.preselectedFromCtx?.(ctx);
      return {
        project: ctx.project,
        ...(preselected !== undefined ? { repositoryId: preselected } : {}),
      };
    },
    output: (ctx, repository) => ({ ...ctx, repository }),
  });
