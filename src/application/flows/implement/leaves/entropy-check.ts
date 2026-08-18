import { Result } from '@src/domain/result.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { computeActionEntropy, detectLowEntropy } from '@src/business/task/escalation-policy.ts';
import {
  plateauWindowSize,
  pooledActionCounts,
  type PlateauTurnRecord,
  windowIsHardStall,
} from '@src/business/task/plateau-detection.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

export interface EntropyCheckDeps {
  /** Same per-spawn budget read the surrounding loop's `shouldContinue` uses. */
  readonly readConfig: () => Promise<{ readonly maxTurns: number }>;
  readonly eventBus: EventBus;
  readonly clock: () => IsoTimestamp;
  /** The operator's `settings.harness.plateauThreshold` — sizes the pooled window. */
  readonly plateauThreshold: number;
  /**
   * `settings.harness.entropyPlateauDetector` — OFF by default. Gated INSIDE the leaf rather than
   * behind a `guard` element so the flow's element list (and its step-order fence tests + the
   * documented traces) stay identical whichever way the knob is set.
   */
  readonly enabled: boolean;
}

interface EntropyCheckInput {
  /**
   * The last `plateauWindowSize(plateauThreshold)` evaluator-turn records of `ctx.plateauHistory`,
   * newest last — the SAME window every other plateau detector reads. Each record carries the
   * generator signal-kind distribution for its turn (`PlateauTurnRecord.actionCounts`).
   */
  readonly window: readonly PlateauTurnRecord[];
  readonly alreadyExiting: boolean;
  /** Turn just completed (`ctx.genEvalTurn`) — compared against the budget so the check never pre-empts the final turn. */
  readonly turnsUsed: number;
}

interface EntropyCheckOutput {
  readonly shouldExit: boolean;
}

/**
 * Chain leaf — the action-entropy plateau detector, running after the fingerprint-repetition one.
 *
 * Computes normalised Shannon entropy over the distribution of the generator's emitted signal
 * KINDS (decision / change / learning / note) POOLED ACROSS THE PLATEAU WINDOW. Low pooled entropy
 * means the generator concentrated its reported actions on a single kind for the whole window, so
 * the leaf re-uses the `plateau` exit kind and the escalation ladder applies the same remedy.
 *
 * WHY POOLED, AND WHY OPT-IN. The detector used to score ONE turn's distribution: a turn emitting
 * three `change` signals scored K=1 → H=0 → plateau, burning an escalation rung plus a whole
 * attempt on a generator that was working normally. Pooling across the window is the fix (an
 * alternating generator pools to K≥2); `settings.harness.entropyPlateauDetector` (default off) is
 * the belt-and-braces — the signal is a proxy for a proxy, so operators opt in deliberately.
 *
 * HONESTY: this is a SIGNAL-KIND-DISTRIBUTION PROXY for action entropy — the harness never sees
 * the AI's raw tool-use, so the spread of reported signal kinds stands in for "action diversity".
 * It is a SECONDARY / softer signal, subordinate to {@link windowIsHardStall} (so it can never
 * override the calibrated predicate's exemptions or pre-empt the operator's threshold), and the
 * budget-precedence guard keeps it from ever pre-empting the final budgeted turn.
 */
export const entropyCheckLeaf = (deps: EntropyCheckDeps, taskId: TaskId): Element<ImplementCtx> =>
  leaf<ImplementCtx, EntropyCheckInput, EntropyCheckOutput>(`entropy-check-${String(taskId)}`, {
    useCase: {
      execute: async (input) => {
        const noExit = Result.ok<EntropyCheckOutput>({ shouldExit: false });
        // Opt-in detector (default off) and no-op when another exit is already pending.
        if (!deps.enabled || input.alreadyExiting) return noExit;

        // Wait for a full window of REAL evidence — the record count, not a turn counter: a turn
        // whose evaluator produced no usable record contributes no evidence and must not count.
        const windowSize = plateauWindowSize(deps.plateauThreshold);
        if (input.window.length < windowSize) return noExit;
        // A record with no stamped distribution (a turn that emitted zero narrative signals)
        // leaves a hole in the window — pooling over it would silently score fewer turns.
        if (input.window.some((record) => record.actionCounts === undefined)) return noExit;

        const entropy = computeActionEntropy(pooledActionCounts(input.window));
        if (!detectLowEntropy(entropy)) return noExit;

        // Calibration gate — honour the operator's threshold AND both progress exemptions.
        if (!windowIsHardStall(input.window, { threshold: deps.plateauThreshold })) return noExit;

        // Budget-precedence guard: if this was the final allowed turn, let finalize
        // synthesise the budget-exhausted exit rather than pre-empting it with a plateau.
        const { maxTurns } = await deps.readConfig();
        if (input.turnsUsed >= Math.max(1, maxTurns)) return noExit;

        deps.eventBus.publish({
          type: 'banner-show',
          id: `entropy-plateau-${String(taskId)}`,
          tier: 'warn',
          message: `Generator action entropy collapsed (H=${entropy.toFixed(2)}) — escalating`,
          cause: 'low-action-entropy',
          at: deps.clock(),
        });

        return Result.ok({ shouldExit: true });
      },
    },
    input: (ctx): EntropyCheckInput => ({
      // SIGNAL-KIND-DISTRIBUTION proxy for action entropy, pooled over the plateau window: each
      // record carries the per-turn spread the evaluator leaf copied off `ctx.lastTurnActionCounts`.
      window: (ctx.plateauHistory ?? []).slice(-plateauWindowSize(deps.plateauThreshold)),
      alreadyExiting: ctx.lastExit !== undefined,
      turnsUsed: ctx.genEvalTurn ?? 0,
    }),
    output: (ctx, out) => {
      if (!out.shouldExit) return ctx;
      // Re-use the plateau exit kind so the escalation ladder applies the same remedy.
      return { ...ctx, lastExit: { kind: 'plateau', dimensions: [], source: 'entropy' } };
    },
  });
