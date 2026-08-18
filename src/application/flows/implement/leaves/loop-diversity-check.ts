import { Result } from '@src/domain/result.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { detectRepetitiveLoop } from '@src/business/task/escalation-policy.ts';
import {
  failedDimensions,
  plateauWindowSize,
  type PlateauTurnRecord,
  windowIsHardStall,
} from '@src/business/task/plateau-detection.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

export interface LoopDiversityCheckDeps {
  /** Same per-spawn budget read the surrounding loop's `shouldContinue` uses. */
  readonly readConfig: () => Promise<{ readonly maxTurns: number }>;
  readonly eventBus: EventBus;
  readonly clock: () => IsoTimestamp;
  /**
   * The operator's `settings.harness.plateauThreshold` — the ONE knob that sizes every plateau
   * window (see `plateauWindowSize`). Static per launch, threaded from `deps.config.harness` like
   * the loop's other budgets, NOT re-read from `readConfig` (whose shape is the attempt loop's).
   */
  readonly plateauThreshold: number;
}

interface DiversityCheckInput {
  /**
   * The last `plateauWindowSize(plateauThreshold)` evaluator-turn records of `ctx.plateauHistory`,
   * newest last. `start-attempt` clears that history per attempt, so the window can never span an
   * attempt boundary — the per-attempt reset falls out of the ctx read rather than needing tracked
   * state.
   */
  readonly recentRecords: readonly PlateauTurnRecord[];
  readonly alreadyExiting: boolean;
  /** Turn just completed (`ctx.genEvalTurn`) — compared against the budget so the check never pre-empts the final turn. */
  readonly turnsUsed: number;
}

interface DiversityCheckOutput {
  readonly shouldExit: boolean;
  readonly dimensions?: readonly string[];
}

/**
 * Fingerprint = sorted set of a turn's currently-failed dimension names joined by '|'. A passing
 * evaluation (all dimensions green) has no failed dimensions and so no fingerprint.
 */
const fingerprintOf = (record: PlateauTurnRecord): string => [...failedDimensions(record.evaluation)].sort().join('|');

/**
 * Chain leaf — the fingerprint-repetition plateau detector, running after each evaluator turn.
 *
 * A gen-eval loop that re-emits the identical failed-dimension fingerprint round after round has
 * plateaued. On collapse the leaf sets a `plateau` exit so the escalation policy can climb the
 * model ladder or apply a change-of-approach nudge, and shows a warn banner.
 *
 * SUBORDINATE TO THE CALIBRATED PREDICATE. The detector windows from the operator's
 * `plateauThreshold` (never a window of its own) and only speaks on a window
 * `windowIsHardStall` — the very cascade `computePlateauVerdict` runs — also calls stalled. It
 * can therefore neither pre-empt the knob nor exit a loop the calibrated predicate deliberately
 * exempted for a shifted critique or a changed work product. Repeating one fingerprint while the
 * AI keeps editing the tree is exactly the exempted case, and used to cost a whole escalation rung.
 *
 * The verdict is a pure derivation from `ctx.plateauHistory` — the window is re-read from ctx on
 * every turn rather than tracked in a rolling buffer, so a resumed run, a re-created element, and
 * an attempt boundary all read exactly the history ctx holds.
 */
export const loopDiversityCheckLeaf = (deps: LoopDiversityCheckDeps, taskId: TaskId): Element<ImplementCtx> =>
  leaf<ImplementCtx, DiversityCheckInput, DiversityCheckOutput>(`loop-diversity-check-${String(taskId)}`, {
    useCase: {
      execute: async (input) => {
        const noExit = Result.ok<DiversityCheckOutput>({ shouldExit: false });
        // Skip when the evaluator already set a terminal exit this turn, or when the evaluator
        // recorded no turn at all (generator self-blocked — no record to fingerprint).
        const latest = input.recentRecords[input.recentRecords.length - 1];
        if (input.alreadyExiting || latest === undefined) return noExit;

        // No failed dimensions → nothing to repeat (the loop would exit via 'passed' anyway).
        const failed = failedDimensions(latest.evaluation);
        if (failed.size === 0) return noExit;

        const windowSize = plateauWindowSize(deps.plateauThreshold);
        if (!detectRepetitiveLoop(input.recentRecords.map(fingerprintOf), windowSize)) return noExit;

        // Calibration gate — honour the operator's threshold AND both progress exemptions.
        if (!windowIsHardStall(input.recentRecords, { threshold: deps.plateauThreshold })) return noExit;

        // Budget exhaustion takes precedence. When this was the final turn the loop would run
        // anyway (turnsUsed === budget), there is no remaining budget for an early escalation
        // to reclaim — the truthful terminal state is `budget-exhausted`, so let `finalize`
        // synthesise it instead of pre-empting it with a `plateau`. This preserves the
        // invariant that a run where every turn fails from the very start (never any progress)
        // always exits as `budget-exhausted`. Read the same `readConfig` budget the loop's
        // `shouldContinue` uses so a runtime config change can't diverge the two.
        const { maxTurns } = await deps.readConfig();
        if (input.turnsUsed >= Math.max(1, maxTurns)) return noExit;

        // Diversity collapsed — the generator repeated the exact same failure pattern for the
        // whole plateau window without any approach change.
        deps.eventBus.publish({
          type: 'banner-show',
          id: `loop-diversity-${String(taskId)}`,
          tier: 'warn',
          message: 'Generator is repeating the same approach — escalating',
          cause: 'loop-diversity-exhausted',
          at: deps.clock(),
        });

        return Result.ok({ shouldExit: true, dimensions: [...failed] });
      },
    },
    input: (ctx): DiversityCheckInput => ({
      recentRecords: (ctx.plateauHistory ?? []).slice(-plateauWindowSize(deps.plateauThreshold)),
      alreadyExiting: ctx.lastExit !== undefined,
      turnsUsed: ctx.genEvalTurn ?? 0,
    }),
    output: (ctx, out) => {
      if (!out.shouldExit || out.dimensions === undefined) return ctx;
      return { ...ctx, lastExit: { kind: 'plateau', dimensions: out.dimensions, source: 'diversity' } };
    },
  });
