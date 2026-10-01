/** Pre-launch repository-selection step used by `use-flow-launcher.ts`. */

import type { Choice, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';

/**
 * Flow ids whose chains run `pickRepositoryLeaf` — derived from the only three flows under `application/flows/` that
 * import it (`detect-scripts`, `detect-skills`, `readiness`).
 */
const REPO_SELECTING_FLOW_IDS: ReadonlySet<string> = new Set(['detect-scripts', 'detect-skills', 'readiness']);

/** Whether launching `flowId` runs the `pickRepositoryLeaf` step (and thus selects a repository). */
export const flowSelectsRepository = (flowId: string): boolean => REPO_SELECTING_FLOW_IDS.has(flowId);

export interface RepositorySelectionInput {
  readonly interactive: InteractivePrompt;
  readonly flowId: string;
  readonly flowTitle: string;
  readonly project: Project | undefined;
  /** The session-pinned repository, offered first (default highlight) when set. */
  readonly pinnedRepositoryId: RepositoryId | undefined;
}

/**
 * Outcome of the repository-selection step. - `skip` — flow doesn't select a repo, or the project has 0/1 repository.
 */
export type RepositorySelectionResult =
  | { readonly kind: 'skip' }
  | { readonly kind: 'selected'; readonly repositoryId: RepositoryId }
  | { readonly kind: 'cancel' };

/**
 * Order the choices so the currently-pinned repository is first (default highlight) when set; otherwise keep project
 * order.
 */
const buildChoices = (
  repositories: readonly Repository[],
  pinnedRepositoryId: RepositoryId | undefined
): ReadonlyArray<Choice<Repository>> => {
  const ordered =
    pinnedRepositoryId !== undefined
      ? [
          ...repositories.filter((r) => r.id === pinnedRepositoryId),
          ...repositories.filter((r) => r.id !== pinnedRepositoryId),
        ]
      : repositories;
  return ordered.map((r) => ({
    label: `${r.name} (${String(r.slug)})`,
    value: r,
    description: String(r.path),
  }));
};

/** Prompt for the repository a repo-selecting flow should run against. */
export const runRepositorySelection = async (input: RepositorySelectionInput): Promise<RepositorySelectionResult> => {
  if (!flowSelectsRepository(input.flowId)) return { kind: 'skip' };

  const repositories = input.project?.repositories ?? [];
  // Single-repo projects auto-select inside `pickRepositoryLeaf`; a 0-repo project surfaces its
  // own InvalidStateError there. Either way no extra prompt belongs here.
  if (repositories.length <= 1) return { kind: 'skip' };

  const choices = buildChoices(repositories, input.pinnedRepositoryId);
  const message = `Which repository should "${input.flowTitle}" run against?`;
  const picked = await input.interactive.askChoice(message, choices);
  if (!picked.ok) return { kind: 'cancel' };
  return { kind: 'selected', repositoryId: picked.value.id };
};
