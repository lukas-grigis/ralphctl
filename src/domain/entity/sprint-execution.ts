import { Result } from '@src/domain/result.ts';
import type { Entity } from '@src/domain/entity/_base/entity.ts';
import type { HttpUrl } from '@src/domain/value/http-url.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { parseHttpUrl } from '@src/domain/value/parsers/parse-http-url.ts';
import { type ValidationError } from '@src/domain/value/error/validation-error.ts';

/**
 * Per-sprint execution record — pairs 1:1 with a `Sprint` via the shared `SprintId` (no
 * separate identity of its own). Carries delivery facts (branch, PR url) and audit data
 * (setup-script run timestamps) that are orthogonal to sprint planning.
 *
 * Functions here are pure structural mutations with no own state machine. Use cases gate
 * calls on the partner Sprint's status (e.g., reject branch edits after `closeSprint`).
 */
export interface SprintExecution extends Entity<SprintId> {
  /** Same value as {@link Entity.id}. Retained for naming clarity at call sites. */
  readonly sprintId: SprintId;
  readonly branch: string | null;
  readonly pullRequestUrl: HttpUrl | null;
  /**
   * Audit trail of sprint-start setup-script runs per repository. Preserved across close.
   * Modeled as an array (not a Map) so it survives `JSON.stringify` losslessly. At most one
   * entry per `repositoryId` — `recordExecutionSetupRun` upserts.
   */
  readonly setupRanAt: readonly SetupRun[];
}

/** One entry in {@link SprintExecution.setupRanAt}. */
export interface SetupRun {
  readonly repositoryId: RepositoryId;
  readonly ranAt: IsoTimestamp;
}

export interface SprintExecutionCreateInput {
  readonly sprintId: SprintId;
}

export const createSprintExecution = (input: SprintExecutionCreateInput): SprintExecution => ({
  id: input.sprintId,
  sprintId: input.sprintId,
  branch: null,
  pullRequestUrl: null,
  setupRanAt: [],
});

export const setExecutionBranch = (execution: SprintExecution, branch: string): SprintExecution => ({
  ...execution,
  branch,
});

export const recordExecutionPullRequestUrl = (
  execution: SprintExecution,
  url: string
): Result<SprintExecution, ValidationError> => {
  const parsed = parseHttpUrl('sprint-execution.pullRequestUrl', url);
  if (!parsed.ok) return Result.error(parsed.error);
  return Result.ok({ ...execution, pullRequestUrl: parsed.value });
};

/** Upsert by `repositoryId` — most-recent run wins. Order is "earliest first appearance" to keep diffs stable. */
export const recordExecutionSetupRun = (
  execution: SprintExecution,
  repo: RepositoryId,
  at: IsoTimestamp
): SprintExecution => {
  const idx = execution.setupRanAt.findIndex((entry) => entry.repositoryId === repo);
  if (idx === -1) {
    return { ...execution, setupRanAt: [...execution.setupRanAt, { repositoryId: repo, ranAt: at }] };
  }
  const next = [...execution.setupRanAt];
  next[idx] = { repositoryId: repo, ranAt: at };
  return { ...execution, setupRanAt: next };
};

/** Lookup helper — returns `undefined` when `repo` has not been recorded yet. */
export const findExecutionSetupRun = (execution: SprintExecution, repo: RepositoryId): IsoTimestamp | undefined =>
  execution.setupRanAt.find((entry) => entry.repositoryId === repo)?.ranAt;
