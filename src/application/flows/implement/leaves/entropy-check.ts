import { Result } from '@src/domain/result.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { computeActionEntropy, detectLowEntropy } from '@src/business/task/escalation-policy.ts';
import { DIVERSITY_WINDOW_SIZE } from '@src/application/flows/implement/leaves/loop-diversity-check.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

export interface EntropyCheckDeps {
  /** Same per-spawn budget read the surrounding loop's `shouldContinue` uses. */
  readonly readConfig: () => Promise<{ readonly maxTurns: number }>;
  readonly eventBus: EventBus;
  readonly clock: () => IsoTimestamp;
}

interface EntropyCheckInput {
  /** Per-kind action counts for the current turn. Undefined when the generator stamped none. */
  readonly actionCounts: Map<string, number> | undefined;
  readonly alreadyExiting: boolean;
  readonly turnsUsed: number;
}

interface EntropyCheckOutput {
  readonly shouldExit: boolean;
}

/**
 * Chain leaf — the action-entropy plateau detector, running after the fingerprint-repetition one.
 *
 * Computes normalised Shannon entropy over the distribution of the generator's emitted signal
 * KINDS this turn (decision / change / learning / note), read from `ctx.lastTurnActionCounts`
 * (stamped by the generator leaf). Low entropy means the generator concentrated its reported
 * actions on a single kind — a leading indicator of a plateau, so the leaf re-uses the `plateau`
 * exit kind and the escalation ladder applies the same remedy.
 *
 * HONESTY: this is a SIGNAL-KIND-DISTRIBUTION PROXY for action entropy — the harness never sees
 * the AI's raw tool-use, so the spread of reported signal kinds stands in for "action diversity".
 * It is a SECONDARY / softer signal to the fingerprint-repetition detector, and the
 * budget-precedence guard keeps it from ever pre-empting the final budgeted turn.
 */
export const entropyCheckLeaf = (deps: EntropyCheckDeps, taskId: TaskId): Element<ImplementCtx> =>
  leaf<ImplementCtx, EntropyCheckInput, EntropyCheckOutput>(`entropy-check-${String(taskId)}`, {
    useCase: {
      execute: async (input) => {
        const noExit = Result.ok<EntropyCheckOutput>({ shouldExit: false });
        // No signal-kind distribution stamped this turn (round 1 before any generator turn, or a
        // turn that emitted zero narrative signals) — no evidence of low entropy, so no-op.
        if (input.actionCounts === undefined) return noExit;
        // Skip when another exit is already pending or insufficient turns have elapsed.
        if (input.alreadyExiting || input.turnsUsed < DIVERSITY_WINDOW_SIZE) return noExit;
        // Budget-precedence guard: if this was the final allowed turn, let finalize
        // synthesise the budget-exhausted exit rather than pre-empting it with a plateau.
        const { maxTurns } = await deps.readConfig();
        if (input.turnsUsed >= Math.max(1, maxTurns)) return noExit;

        const entropy = computeActionEntropy(input.actionCounts);
        if (!detectLowEntropy(entropy)) return noExit;

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
      // SIGNAL-KIND-DISTRIBUTION proxy for action entropy: read the generator leaf's per-turn
      // `lastTurnActionCounts` (decision/change/learning/note spread for the turn just completed).
      // Copy into a mutable `Map` for `computeActionEntropy`; undefined when nothing was stamped.
      actionCounts: ctx.lastTurnActionCounts !== undefined ? new Map(ctx.lastTurnActionCounts) : undefined,
      alreadyExiting: ctx.lastExit !== undefined,
      turnsUsed: ctx.genEvalTurn ?? 0,
    }),
    output: (ctx, out) => {
      if (!out.shouldExit) return ctx;
      // Re-use the plateau exit kind so the escalation ladder applies the same remedy.
      return { ...ctx, lastExit: { kind: 'plateau', dimensions: [], source: 'entropy' } };
    },
  });
