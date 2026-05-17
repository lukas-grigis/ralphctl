import type { Result } from '@src/domain/result.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ReadinessCtx } from '@src/application/flows/readiness/ctx.ts';

export interface ConfirmReadinessLeafDeps {
  readonly interactive: InteractivePrompt;
}

interface ConfirmReadinessInput {
  readonly proposedContent: string;
  readonly targetPath: AbsolutePath;
  readonly proposedSetupScript?: string;
  readonly proposedVerifyScript?: string;
}

/**
 * Show the user the AI's proposal and ask whether to write it. The leaf renders the proposal
 * inline via the `askConfirm` message so the user sees the body without a separate preview
 * channel — the `ConsolePrompt` adapter prints the message verbatim before reading the answer.
 *
 * The confirm covers all three artefacts (context file body, setup script, verify script) as
 * a single yes/no — `accept` writes everything proposed, `decline` writes nothing. Per-artefact
 * accept/decline is a UX refinement to add when there's a real use case for it.
 *
 * Decline (`accepted: false`) is the safe default path the next leaf observes — `writeReadinessLeaf`
 * is a no-op when `ctx.accepted !== true`.
 */
const confirmReadinessUseCase = async (
  deps: ConfirmReadinessLeafDeps,
  input: ConfirmReadinessInput
): Promise<Result<boolean, DomainError>> => {
  const sections: string[] = [`Proposed content for ${String(input.targetPath)}:`, '', input.proposedContent];
  if (input.proposedSetupScript !== undefined) {
    sections.push('', `Setup script (sprint-start prep): ${input.proposedSetupScript}`);
  }
  if (input.proposedVerifyScript !== undefined) {
    sections.push('', `Verify script (post-task gate): ${input.proposedVerifyScript}`);
  }
  sections.push('', 'Apply this proposal?');
  return deps.interactive.askConfirm({ message: sections.join('\n') });
};

export const confirmReadinessLeaf = (deps: ConfirmReadinessLeafDeps): Element<ReadinessCtx> =>
  leaf<ReadinessCtx, ConfirmReadinessInput, boolean>('confirm', {
    useCase: {
      execute: async (input) => confirmReadinessUseCase(deps, input),
    },
    input: (ctx) => {
      if (ctx.proposal === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-confirm',
          attemptedAction: 'confirm',
          message: 'confirm: ctx.proposal is undefined — propose must run first',
        });
      }
      return {
        proposedContent: ctx.proposal.proposedContent,
        targetPath: ctx.proposal.targetPath,
        ...(ctx.proposal.proposedSetupScript !== undefined
          ? { proposedSetupScript: ctx.proposal.proposedSetupScript }
          : {}),
        ...(ctx.proposal.proposedVerifyScript !== undefined
          ? { proposedVerifyScript: ctx.proposal.proposedVerifyScript }
          : {}),
      };
    },
    output: (ctx, accepted) => ({ ...ctx, accepted }),
  });
