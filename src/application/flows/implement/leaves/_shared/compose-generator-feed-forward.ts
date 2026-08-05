import type { InProgressTask } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { composeDimensionTrajectory } from '@src/business/task/dimension-trajectory.ts';
import { composeTaskEpisodes } from '@src/business/task/compose-task-episodes.ts';
import { summariseEpisodes } from '@src/business/task/episode-summary.ts';
import { deriveTaskKind } from '@src/business/task/derive-task-kind.ts';
import { composePriorLearnings } from '@src/application/flows/_shared/memory/compose-prior-learnings.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Concatenated free text describing the current task — name, description, and each acceptance
 * criterion's assertion — fed to `composePriorLearnings` as `PriorLearningsContext.taskText`. It
 * drives both the relevance token-overlap scoring and the abstain gate (arXiv 2602.08316), so
 * omitting a field here just means that field contributes no topical signal, never a crash.
 * Criterion ids/commands carry no topical signal — only the human-readable assertion does.
 */
const composeTaskText = (task: InProgressTask): string =>
  [task.name, task.description ?? '', ...task.verificationCriteria.map((c) => c.assertion)]
    .filter((s) => s.trim().length > 0)
    .join('\n');

/** Pure ctx-derived feed-forward prompt blocks — see {@link composeGeneratorFeedForward}. */
export interface GeneratorFeedForward {
  readonly dimensionTrajectory?: string;
  readonly priorLearnings?: string;
  readonly priorEpisodes?: string;
}

/**
 * Compose the three ctx-derived feed-forward prompt blocks (dimension trajectory, prior
 * learnings, prior episodes) — pure ctx/task reads, no I/O, so it can run inside a chain leaf's
 * synchronous `input` projection. Shared by the gen-eval loop's own generator turn
 * (`generator.ts`'s `makeGeneratorInput`) and every best-of-N candidate spawn
 * (`best-of-n-candidate.ts`): a candidate is the harness's most expensive turn (N full sessions
 * bought by the granted attempt), so it must see the SAME accumulated context a normal turn
 * would, not a silently narrower one.
 */
export const composeGeneratorFeedForward = (
  ctx: Pick<ImplementCtx, 'plateauHistory' | 'priorLearnings' | 'tasks' | 'sprintId'>,
  task: InProgressTask,
  taskId: TaskId,
  roundNum: number,
  cfg: {
    readonly cwd: AbsolutePath;
    readonly clock: () => IsoTimestamp;
    readonly plateauThreshold: number;
    readonly maxTurns: number;
  }
): GeneratorFeedForward => {
  // Compose the dimension-trajectory feed-forward (principles 6 + 15) from the per-attempt
  // evaluator-turn history. Pure ctx read — `composeDimensionTrajectory` returns '' until there
  // are two turns to diff (round 1 has none), so the prompt's PRIOR_CRITIQUE_SECTION collapses
  // cleanly on the first round.
  const dimensionTrajectory = composeDimensionTrajectory({
    history: ctx.plateauHistory ?? [],
    plateauThreshold: cfg.plateauThreshold,
    roundNum,
    maxTurns: cfg.maxTurns,
  });
  // Cross-sprint procedural memory (principle 3) loaded once by the prologue's `load-learnings`.
  // Pure ctx read; '' when the ledger was absent/empty so the prompt placeholder collapses. The
  // context activates relevance scoring AND the abstain gate (arXiv 2602.08316) — without it
  // selection silently degrades to recency-only, which is why this must not be omitted here.
  const priorLearnings = composePriorLearnings(ctx.priorLearnings ?? [], {
    repo: String(cfg.cwd),
    taskKind: deriveTaskKind(task),
    taskText: composeTaskText(task),
    nowIso: cfg.clock(),
  });
  // Episodic memory (R4) derived from this sprint's already-settled sibling tasks. Pure ctx
  // read; '' until a sibling has settled (done/blocked) so the prompt placeholder collapses.
  const priorEpisodes = summariseEpisodes(composeTaskEpisodes(ctx.tasks ?? [], taskId, ctx.sprintId));
  return {
    ...(dimensionTrajectory.length > 0 ? { dimensionTrajectory } : {}),
    ...(priorLearnings.length > 0 ? { priorLearnings } : {}),
    ...(priorEpisodes.length > 0 ? { priorEpisodes } : {}),
  };
};
