import { basename } from 'node:path';
import type { Task } from '@src/domain/entity/task.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import type { Element } from '@src/application/chain/element.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { preflightTaskLeaf, type DirtyTreePolicy } from '@src/application/flows/implement/leaves/preflight-task.ts';
import { resolveRepoOrThrow, type RepoExecConfig } from '@src/application/flows/implement/leaves/resolve-repo.ts';
import { workingTreeCleanCheckLeaf } from '@src/application/flows/implement/leaves/working-tree-clean-check.ts';

/**
 * Pure helpers that project the implement chain's input bag into the per-repo derived shapes
 * the outer chain consumes:
 *
 *   - `uniqueRepoCwdsForTasks` — unique set of repo paths the sprint's todo tasks touch.
 *     `resolve-branch` checks the sprint branch out in each; `preflight-task` runs the
 *     dirty-tree gate once per repo. (Setup scripts iterate the full project — see
 *     `setupRepoEntriesForTasks` below.)
 *   - `setupRepoEntriesForTasks` — the launcher-facing setup-script row per affected repo.
 *     Repos with no assigned task get nothing to verify and shouldn't pay the per-repo setup
 *     cost (a no-op `pnpm install` on an untouched gateway is still ~10s of wasted wall time).
 *   - `buildPreflightLeaves` / `buildWorkingTreeCleanLeaves` — per-repo leaf factories with
 *     unique trace IDs (cwd baked into the name so plan/trace merge doesn't collapse rows) and
 *     basename labels for the rail.
 *
 * Extracted from `flow.ts` to keep the orchestrator focused on chain shape rather than IIFE
 * machinery — every helper is a pure projection over `(repositories, todoTasks)`.
 */

export const uniqueRepoCwdsForTasks = (
  repositories: ReadonlyMap<RepositoryId, RepoExecConfig>,
  todoTasks: readonly Task[]
): readonly AbsolutePath[] => {
  const seen = new Set<string>();
  const out: AbsolutePath[] = [];
  for (const task of todoTasks) {
    const repo = resolveRepoOrThrow(repositories, task);
    if (seen.has(String(repo.path))) continue;
    seen.add(String(repo.path));
    out.push(repo.path);
  }
  return out;
};

export interface SetupRepoEntry {
  readonly repositoryId: RepositoryId;
  readonly path: AbsolutePath;
  readonly setupScript?: string;
}

export const setupRepoEntriesForTasks = (
  repositories: ReadonlyMap<RepositoryId, RepoExecConfig>,
  todoTasks: readonly Task[]
): readonly SetupRepoEntry[] => {
  const seen = new Set<string>();
  const out: SetupRepoEntry[] = [];
  for (const task of todoTasks) {
    const repo = resolveRepoOrThrow(repositories, task);
    const id = task.repositoryId;
    if (seen.has(String(id))) continue;
    seen.add(String(id));
    out.push({
      repositoryId: id,
      path: repo.path,
      ...(repo.setupScript !== undefined ? { setupScript: repo.setupScript } : {}),
    });
  }
  return out;
};

export interface PreflightLeavesDeps {
  readonly gitRunner: GitRunner;
  readonly interactive: InteractivePrompt;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
}

/**
 * Per-repo preflight step ID. The cwd is baked into the name so each leaf in the per-repo
 * iteration has a unique trace identifier (plan/trace merge keys on element name). The label
 * strips the absolute path back down to its basename for the rail — the rail's job is "which
 * repo are we preflighting?", not "what's the full filesystem layout?". On a single-repo
 * sprint the discriminator is redundant; on a multi-repo sprint dropping it would collapse
 * every preflight entry into the same row in the plan/trace merge and the operator could not
 * tell at a glance which repo a failure belongs to.
 */
export const buildPreflightLeaves = (
  deps: PreflightLeavesDeps,
  cwds: readonly AbsolutePath[],
  dirtyTreePolicy: DirtyTreePolicy
): ReadonlyArray<Element<ImplementCtx>> =>
  cwds.map((cwd, i) =>
    preflightTaskLeaf(
      {
        gitRunner: deps.gitRunner,
        interactive: deps.interactive,
        clock: deps.clock,
        logger: deps.logger,
        dirtyTreePolicy,
      },
      cwd,
      `preflight-task-${String(i + 1)}-${String(cwd)}`,
      { label: `preflight · ${basename(String(cwd))}` }
    )
  );

export interface WorkingTreeCleanLeavesDeps {
  readonly gitRunner: GitRunner;
  readonly logger: Logger;
}

/**
 * Pre-setup hard gate — one leaf per affected repo. Fails the chain when any repo's working
 * tree is dirty so the user sees the problem before setup-script spends multiple minutes
 * running `pnpm install` / migrations etc against a tree that may make setup fail anyway.
 * Sequenced together across ALL repos before any setup leaf runs: a dirty repo 2 should not
 * wait for repo 1's setup to finish. ID + label mirror the preflight-task pattern so the rail
 * disambiguates per-repo entries without leaking the absolute path into the label.
 */
export const buildWorkingTreeCleanLeaves = (
  deps: WorkingTreeCleanLeavesDeps,
  cwds: readonly AbsolutePath[]
): ReadonlyArray<Element<ImplementCtx>> =>
  cwds.map((cwd, i) =>
    workingTreeCleanCheckLeaf(
      { gitRunner: deps.gitRunner, logger: deps.logger },
      cwd,
      `working-tree-clean-check-${String(i + 1)}-${String(cwd)}`,
      { label: `working-tree clean · ${basename(String(cwd))}` }
    )
  );
