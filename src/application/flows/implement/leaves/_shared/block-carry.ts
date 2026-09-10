import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { GeneratorTurnExit } from '@src/business/task/run-generator-turn.ts';

/**
 * Project a gen-eval exit onto the block-carry fields of the chain ctx. Only a `self-blocked` exit
 * carries anything: the reason AND the generator's own structured triage both come off its
 * `task-blocked` signal, and neither exists for a crash-induced block — nothing reported one. The
 * triage travels as ONE object so a field added to it reaches `settle-attempt` without this hop
 * needing to learn about it, which is how the triage came to be collected and then dropped before.
 *
 * A `crashed` exit deliberately carries NO block reason: `finalize-gen-eval` is the sole authority
 * for whether a crash blocks the task, and a reason stamped here would leak past it.
 */
export const projectBlockCarry = (
  exit: GeneratorTurnExit
): Pick<ImplementCtx, 'lastBlockReason' | 'lastBlockTriage'> => {
  if (exit.kind !== 'self-blocked') return {};
  return {
    lastBlockReason: exit.reason,
    lastBlockTriage: {
      ...(exit.blockerClass !== undefined ? { blockerClass: exit.blockerClass } : {}),
      ...(exit.question !== undefined ? { question: exit.question } : {}),
      ...(exit.whatUnblocksMe !== undefined ? { whatUnblocksMe: exit.whatUnblocksMe } : {}),
    },
  };
};
