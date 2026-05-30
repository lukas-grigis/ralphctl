import type { Result } from '@src/domain/result.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { AssistantTool } from '@src/integration/ai/readiness/_engine/tool.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { DistillLearningsCtx } from '@src/application/flows/_shared/memory/distill-ctx.ts';

export interface DistillConfirmLeafDeps {
  readonly interactive: InteractivePrompt;
}

interface DistillConfirmInput {
  readonly proposedContent: string;
  readonly targetPath: AbsolutePath;
}

/**
 * Distill-OWNED human gate — scoped to one {@link AssistantTool} per instance. Shows the operator
 * the AI's full proposed context file and asks whether to land it. `accept` writes; `decline`
 * makes the downstream write leaf a no-op. The prompt renders the proposal inline so the operator
 * sees the body without a separate preview channel (the Ink adapter prints the message verbatim).
 *
 * A `Ctrl+C` at this prompt surfaces as `AbortError` through the `Result` channel; the sequential
 * sub-chain then skips write + stamp, so the ledger stays un-stamped.
 */
const distillConfirmUseCase = async (
  deps: DistillConfirmLeafDeps,
  input: DistillConfirmInput
): Promise<Result<boolean, DomainError>> => {
  const message = [
    `Proposed updated context file for ${String(input.targetPath)}:`,
    '',
    input.proposedContent,
    '',
    'Apply this proposal?',
  ].join('\n');
  return deps.interactive.askConfirm({ message });
};

/**
 * Build the distill-owned confirm leaf for one tool.
 *
 * @public
 */
export const distillConfirmLeaf = (deps: DistillConfirmLeafDeps, tool: AssistantTool): Element<DistillLearningsCtx> =>
  leaf<DistillLearningsCtx, DistillConfirmInput, boolean>(`distill-confirm-${tool}`, {
    useCase: {
      execute: async (input) => distillConfirmUseCase(deps, input),
    },
    input: (ctx) => {
      const entry = ctx.entries[tool];
      if (entry?.proposedContent === undefined || entry.targetPath === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-distill-confirm',
          attemptedAction: 'distill-confirm',
          message: `distill-confirm-${tool}: ctx.entries[${tool}].proposedContent is undefined — distill-propose must run first`,
        });
      }
      return { proposedContent: entry.proposedContent, targetPath: entry.targetPath };
    },
    output: (ctx, accepted) => ({
      ...ctx,
      entries: { ...ctx.entries, [tool]: { ...ctx.entries[tool], accepted } },
    }),
  });
