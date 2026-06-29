import type { BlockedTask, CriterionStatus, DoneTask, InProgressTask } from '@src/domain/entity/task.ts';
import type { CriterionVerdict } from '@src/domain/signal.ts';

/** A settled task — the shapes {@link applyCriteriaVerdicts} folds verdicts onto. */
type SettledTask = DoneTask | InProgressTask | BlockedTask;

/**
 * Fold the evaluator's structured per-criterion verdicts onto a task's durable, HARNESS-owned
 * `criteriaVerdicts` map. Pure: derives the map solely from the structured `graded` signal and the
 * task's own criteria — never from agent prose.
 *
 * Semantics:
 *  - Every current {@link import('@src/domain/entity/task.ts').VerificationCriterion} gets a slot,
 *    seeded from the PRIOR verdict when present, else `'unknown'` — so the persisted map always
 *    describes the full checklist, and an id that has never been graded reads as `unknown` rather
 *    than silently missing.
 *  - This round's `graded` verdicts then overlay: each is set to `'passed'` / `'failed'`. Ids the
 *    evaluator did not grade this round keep their seeded (prior-or-unknown) value, so a partial
 *    round never erases an earlier verdict.
 *  - A graded id that is no longer a current criterion is still recorded (defensive) but does not
 *    appear in the seed, so stale criteria prune naturally on the next fold.
 *
 * Empty `graded` → the task is returned unchanged (no evaluation to fold; never fabricate slots).
 *
 * Generic over the settled-task shape so the caller's narrow type (e.g. `InProgressTask`) is
 * preserved — the `as T` re-narrows the object-spread result, sound because the fold only writes the
 * optional `criteriaVerdicts` field every member already declares.
 */
export const applyCriteriaVerdicts = <T extends SettledTask>(task: T, graded: readonly CriterionVerdict[]): T => {
  if (graded.length === 0) return task;
  const prior = task.criteriaVerdicts ?? {};
  const next: Record<string, CriterionStatus> = {};
  for (const criterion of task.verificationCriteria) {
    next[criterion.id] = prior[criterion.id] ?? 'unknown';
  }
  for (const verdict of graded) {
    next[verdict.id] = verdict.passed ? 'passed' : 'failed';
  }
  return { ...task, criteriaVerdicts: next } as T;
};
