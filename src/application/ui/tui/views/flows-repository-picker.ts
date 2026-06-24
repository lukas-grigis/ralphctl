/**
 * Pre-launch repository-selection step used by `flows-view.tsx`. Runs BEFORE
 * {@link runCustomizePicker} so the launch sequence reads "pick repo, then customize provider".
 *
 * Historically the session-pinned repository (`ui.sessionRepositoryId`) was threaded as a HARD
 * pre-selection into every launch, which made `pickRepositoryLeaf` skip its prompt forever — the
 * user could never change the repo after the first pick of a session. This step turns that hard
 * lock into a SOFT default: on every launch of a repo-selecting flow against a multi-repo
 * project, the user re-picks the repository with the previously-pinned repo offered first (the
 * default highlight). Single-repo projects and non-repo-selecting flows skip the prompt entirely
 * — `pickRepositoryLeaf` still auto-selects the lone repo, and the pin keeps pre-selecting it.
 *
 * Extracted from the view into a standalone module so tests can drive it with a scripted
 * {@link InteractivePrompt} fake without mounting Ink — mirroring `flows-customize-picker.ts`.
 */

import type { Choice, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';

/**
 * Flow ids whose chains run `pickRepositoryLeaf` — derived from the only three flows under
 * `application/flows/` that import it (`detect-scripts`, `detect-skills`, `readiness`). An
 * explicit allowlist is clearest here: `manifest.requiresProject` is broader (every
 * project-scoped flow), so it would over-trigger the repository prompt for flows that never
 * pick a repo.
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
 * Outcome of the repository-selection step.
 *  - `skip`     — flow doesn't select a repo, or the project has 0/1 repository; the launcher
 *                 falls back to its existing behavior (single-repo projects auto-select inside
 *                 the chain). No prompt shown.
 *  - `selected` — the user picked a repository; its id threads into the launch and re-pins.
 *  - `cancel`   — the user dismissed the prompt (Esc / AbortError); the launcher must NOT launch.
 */
export type RepositorySelectionResult =
  | { readonly kind: 'skip' }
  | { readonly kind: 'selected'; readonly repositoryId: RepositoryId }
  | { readonly kind: 'cancel' };

/**
 * Order the choices so the currently-pinned repository is first (default highlight) when set;
 * otherwise keep project order. Rendering mirrors `pick-repository.ts` exactly so the two
 * surfaces read identically.
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

/**
 * Prompt for the repository a repo-selecting flow should run against. Returns `skip` (no prompt)
 * for non-repo flows and single-repo projects; otherwise asks the user via `askChoice` with the
 * pinned repo offered first. Cancellation (the `askChoice` error channel — typically
 * `AbortError`) surfaces as `cancel` so the caller can bail without launching.
 */
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
