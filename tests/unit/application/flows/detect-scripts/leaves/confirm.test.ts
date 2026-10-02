import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { VerifyGateProposal } from '@src/domain/signal.ts';
import type { DetectScriptsCtx } from '@src/application/flows/detect-scripts/ctx.ts';
import { confirmDetectScriptsLeaf } from '@src/application/flows/detect-scripts/leaves/confirm.ts';
import { FIXED_PROJECT_ID, makeRepository } from '@tests/fixtures/domain.ts';

const notScripted = (): Result<never, DomainError> =>
  Result.error(new ValidationError({ field: 'fake', value: null, message: 'not scripted' }));

/** InteractivePrompt whose `askChoice` always answers `choice` and records the prompt text. */
const choosingPrompt = (choice: string): InteractivePrompt & { readonly choiceMessages: readonly string[] } => {
  const choiceMessages: string[] = [];
  return {
    choiceMessages,
    askText: async () => notScripted(),
    askTextArea: async () => notScripted(),
    async askChoice<T>(prompt: string): Promise<Result<T, DomainError>> {
      choiceMessages.push(prompt);
      return Result.ok(choice as T) as Result<T, DomainError>;
    },
    askMultiChoice: async () => notScripted(),
    askConfirm: async () => notScripted(),
  };
};

const GATES: readonly VerifyGateProposal[] = [
  { pathPrefix: 'services/api/', command: 'make -C services/api check' },
  { pathPrefix: 'web/', command: 'make -C web check' },
];

describe('confirm detect-scripts leaf', () => {
  it('treats a verify-gates-only proposal as a real proposal and carries the gates through approve', async () => {
    const prompt = choosingPrompt('approve');
    const ctx: DetectScriptsCtx = {
      projectId: FIXED_PROJECT_ID,
      repository: makeRepository(),
      proposal: { proposedVerifyGates: GATES },
    };

    const result = await confirmDetectScriptsLeaf({ interactive: prompt }).execute(ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.accepted).toBe(true);
    expect(result.value.ctx.proposal?.proposedVerifyGates).toEqual(GATES);
    expect(prompt.choiceMessages).toHaveLength(1);
    expect(prompt.choiceMessages[0]).toContain('Per-module verify gates');
    expect(prompt.choiceMessages[0]).not.toContain('AI returned no proposals');
  });
});
