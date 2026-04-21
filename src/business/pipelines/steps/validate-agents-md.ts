import type { StepContext } from '@src/domain/context.ts';
import type { DomainResult } from '@src/domain/types.ts';
import { Result } from '@src/domain/types.ts';
import { ParseError } from '@src/domain/errors.ts';
import { step } from '@src/business/pipelines/framework/helpers.ts';
import type { LintViolation, OnboardAdapterPort } from '@src/business/ports/onboard-adapter.ts';

/**
 * Context extension carried through the onboard pipeline — the validation
 * step reads `agentsMdDraft` and stores structured violations back into the
 * context for the retry step to act on.
 */
export interface AgentsMdValidationContext extends StepContext {
  agentsMdDraft?: string;
  agentsMdViolations?: LintViolation[];
}

export function validateAgentsMdStep<TCtx extends AgentsMdValidationContext>(adapter: OnboardAdapterPort) {
  return step<TCtx>('validate-agents-md', (ctx): DomainResult<Partial<TCtx>> => {
    const draft = ctx.agentsMdDraft;
    if (!draft || draft.trim().length === 0) {
      return Result.error(new ParseError('Project context file draft is empty — AI discovery produced no content.'));
    }
    const { violations } = adapter.lintAgentsMd(draft);
    const partial: Partial<TCtx> = { agentsMdViolations: violations } as Partial<TCtx>;
    return Result.ok(partial) as DomainResult<Partial<TCtx>>;
  });
}
