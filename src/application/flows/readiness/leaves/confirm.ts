import type { Result } from '@src/domain/result.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { AssistantTool } from '@src/integration/ai/readiness/_engine/tool.ts';
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
 * Decline (`accepted: false`) is the safe default path the next leaf observes —
 * `writeReadinessLeaf` is a no-op when the matching entry's `accepted !== true`.
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

export const confirmReadinessLeaf = (deps: ConfirmReadinessLeafDeps, tool: AssistantTool): Element<ReadinessCtx> =>
  leaf<ReadinessCtx, ConfirmReadinessInput, boolean>(`confirm-${tool}`, {
    useCase: {
      execute: async (input) => confirmReadinessUseCase(deps, input),
    },
    input: (ctx) => {
      const entry = ctx.entries[tool];
      const proposal = entry?.proposal;
      if (proposal === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-confirm',
          attemptedAction: 'confirm',
          message: `confirm: ctx.entries[${tool}].proposal is undefined — propose must run first`,
        });
      }
      return {
        proposedContent: proposal.proposedContent,
        targetPath: proposal.targetPath,
        ...(proposal.proposedSetupScript !== undefined ? { proposedSetupScript: proposal.proposedSetupScript } : {}),
        ...(proposal.proposedVerifyScript !== undefined ? { proposedVerifyScript: proposal.proposedVerifyScript } : {}),
      };
    },
    output: (ctx, accepted) => ({
      ...ctx,
      entries: { ...ctx.entries, [tool]: { ...ctx.entries[tool], accepted } },
    }),
  });
