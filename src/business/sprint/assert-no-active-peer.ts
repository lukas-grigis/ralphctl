import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { ListAll } from '@src/domain/repository/_base/list-all.ts';
import { ConflictError } from '@src/domain/value/error/conflict-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * Single-active-per-project invariant shared by every use case that can LAND a sprint in
 * `active` or `review` — both states hold the sprint branch checked out, and the cross-process
 * repo lock is keyed per sprint dir (`withRepoLock`'s `worktreePath`), not per project, so two
 * sprints of one project sitting in either state at once would not mutually exclude on the
 * shared working tree; their implement/review runs could interleave git operations on it.
 *
 * Scans every sprint for the same `projectId` and rejects with `ConflictError` when a DIFFERENT
 * sprint already holds one of those two states. `action` names the verb the caller is guarding
 * (`'activate'` / `'reopen'`) so the log line and error message read naturally regardless of
 * which transition invoked it.
 *
 * Originally private to {@link activateSprintUseCase}; extracted so
 * {@link reopenDoneSprintUseCase}'s `done → review` hop enforces the same invariant instead of
 * reopening a closed sprint unconditionally next to a live peer.
 */
export const assertNoActivePeer = async (
  candidate: Sprint,
  sprints: ListAll<Sprint>,
  log: Logger,
  action: string
): Promise<Result<undefined, ConflictError | StorageError>> => {
  const all = await sprints.list();
  if (!all.ok) return Result.error(all.error);

  const peer = all.value.find(
    (s) =>
      s.id !== candidate.id && s.projectId === candidate.projectId && (s.status === 'active' || s.status === 'review')
  );
  if (peer === undefined) return Result.ok(undefined);

  log.warn(`refusing to ${action}: another sprint already holds the project`, {
    candidateId: candidate.id,
    peerId: peer.id,
    peerStatus: peer.status,
    projectId: candidate.projectId,
  });
  return Result.error(
    new ConflictError({
      entity: 'sprint',
      field: 'projectId',
      value: String(candidate.projectId),
      message: `cannot ${action} sprint '${String(candidate.slug)}': sprint '${String(peer.slug)}' is already ${peer.status} in this project`,
      hint: `close sprint '${String(peer.slug)}' first ('ralphctl sprint close ${String(peer.id)}' once it's in review)`,
    })
  );
};
