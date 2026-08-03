import { Result } from '@src/domain/result.ts';
import type { Choice, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { readRunBodyPreview } from '@src/integration/ai/runs/_engine/run-artifacts.ts';
import type { DetectSkillsCtx } from '@src/application/flows/detect-skills/ctx.ts';

export interface ConfirmDetectSkillsLeafDeps {
  readonly interactive: InteractivePrompt;
}

interface ConfirmInput {
  readonly repository: Repository;
  readonly proposal: {
    readonly proposedSetupSkill?: string;
    readonly proposedVerifySkill?: string;
  };
  /** Per-run forensic dir. See {@link DetectSkillsCtx.proposal.runDir}. */
  readonly runDir?: AbsolutePath;
}

interface ConfirmOutput {
  readonly accepted: boolean;
  /**
   * Same shape as the input proposal — confirm doesn't currently mutate it (skills are
   * multi-paragraph markdown; inline editing through the askText prompt would be a poor
   * fit). A future iteration could open an external editor for edits.
   */
  readonly proposal: {
    readonly proposedSetupSkill?: string;
    readonly proposedVerifySkill?: string;
  };
}

type Decision = 'approve' | 'reject';
type EmptyDecision = 'skip';

/**
 * Build the acknowledge-and-skip prompt for the "AI returned no proposals" edge case: shows the
 * AI's actual body inline (e.g. a permission request, a confused refusal) so the operator
 * understands *why* nothing came back. Manual authoring is genuinely impractical for
 * multi-paragraph skills, so the only action is acknowledge-and-skip; the run dir path is
 * surfaced regardless so the operator can dig deeper. Mirrors the detect-scripts failsafe.
 */
const buildEmptyProposalPrompt = async (
  input: ConfirmInput
): Promise<{ readonly message: string; readonly choices: ReadonlyArray<Choice<EmptyDecision>> }> => {
  const bodyPreview =
    input.runDir !== undefined
      ? await readRunBodyPreview(input.runDir, {
          truncatedSuffix: `\n[…truncated; full body at ${String(input.runDir)}/body.txt]`,
        })
      : undefined;
  const header = `AI returned no skill proposals for ${input.repository.name} (${String(input.repository.slug)}).`;
  const promptLines: string[] = [header];
  if (bodyPreview !== undefined) {
    promptLines.push('', 'AI response:', bodyPreview);
  } else if (input.runDir !== undefined) {
    promptLines.push('', `Run artifacts: ${String(input.runDir)}`);
  }
  promptLines.push('', 'Acknowledge and skip — the repository will be left untouched.');
  return {
    message: promptLines.join('\n'),
    choices: [{ label: 'Skip', value: 'skip', description: 'Continue without applying any skill.' }],
  };
};

/**
 * Render the proposed setup / verify skill bodies as a Markdown preview, headed by whether each
 * one replaces an existing skill or is newly authored. Editing is out of scope here — skills are
 * multi-paragraph markdown and the `askText` prompt is single-line; trying to edit a
 * 10-paragraph body line-by-line is worse UX than re-running the flow with a tighter prompt. The
 * user can also tweak the persisted skill via the storage file once it lands.
 */
const buildConfirmPreview = (
  input: ConfirmInput,
  nextSetup: string | undefined,
  nextVerify: string | undefined
): string => {
  const preview: string[] = [`Authored skills for ${input.repository.name} (${String(input.repository.slug)}):`, ''];
  if (nextSetup !== undefined) {
    preview.push(`### Setup skill ${input.repository.setupSkill !== undefined ? '(replaces existing)' : '(new)'}`);
    preview.push('');
    preview.push(nextSetup);
    preview.push('');
  }
  if (nextVerify !== undefined) {
    preview.push(`### Verify skill ${input.repository.verifySkill !== undefined ? '(replaces existing)' : '(new)'}`);
    preview.push('');
    preview.push(nextVerify);
    preview.push('');
  }
  return preview.join('\n');
};

/** The approve / reject choice list for the non-empty proposal path. */
const buildConfirmOptions = (): ReadonlyArray<Choice<Decision>> => [
  { label: 'Approve', value: 'approve', description: 'Save the proposed skill bodies to the repository.' },
  { label: 'Reject', value: 'reject', description: 'Leave the repository untouched.' },
];

/**
 * Edge case — no proposed skills at all: acknowledge-and-skip (see {@link buildEmptyProposalPrompt}).
 */
const confirmEmptyProposal = async (
  deps: ConfirmDetectSkillsLeafDeps,
  input: ConfirmInput
): Promise<Result<ConfirmOutput, DomainError>> => {
  const { message, choices } = await buildEmptyProposalPrompt(input);
  const decision = await deps.interactive.askChoice<EmptyDecision>(message, choices);
  if (!decision.ok) return Result.error(decision.error);
  return Result.ok({ accepted: false, proposal: {} });
};

/**
 * Render the proposed bodies as a preview (chunked + headed by source label) and ask
 * approve / reject.
 */
const confirmUseCase = async (
  deps: ConfirmDetectSkillsLeafDeps,
  input: ConfirmInput
): Promise<Result<ConfirmOutput, DomainError>> => {
  const { proposedSetupSkill: nextSetup, proposedVerifySkill: nextVerify } = input.proposal;

  if (nextSetup === undefined && nextVerify === undefined) {
    return confirmEmptyProposal(deps, input);
  }

  const preview = buildConfirmPreview(input, nextSetup, nextVerify);
  const decision = await deps.interactive.askChoice<Decision>(
    `${preview}\nWhat would you like to do?`,
    buildConfirmOptions()
  );
  if (!decision.ok) return Result.error(decision.error);

  if (decision.value === 'reject') {
    return Result.ok({ accepted: false, proposal: {} });
  }
  return Result.ok({
    accepted: true,
    proposal: {
      ...(nextSetup !== undefined ? { proposedSetupSkill: nextSetup } : {}),
      ...(nextVerify !== undefined ? { proposedVerifySkill: nextVerify } : {}),
    },
  });
};

export const confirmDetectSkillsLeaf = (deps: ConfirmDetectSkillsLeafDeps): Element<DetectSkillsCtx> =>
  leaf<DetectSkillsCtx, ConfirmInput, ConfirmOutput>('confirm', {
    useCase: {
      execute: async (input) => confirmUseCase(deps, input),
    },
    input: (ctx) => {
      if (ctx.repository === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-confirm',
          attemptedAction: 'confirm',
          message: 'confirm: ctx.repository is undefined — pick-repository must run first',
        });
      }
      if (ctx.proposal === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-confirm',
          attemptedAction: 'confirm',
          message: 'confirm: ctx.proposal is undefined — propose must run first',
        });
      }
      return {
        repository: ctx.repository,
        proposal: {
          ...(ctx.proposal.proposedSetupSkill !== undefined
            ? { proposedSetupSkill: ctx.proposal.proposedSetupSkill }
            : {}),
          ...(ctx.proposal.proposedVerifySkill !== undefined
            ? { proposedVerifySkill: ctx.proposal.proposedVerifySkill }
            : {}),
        },
        ...(ctx.proposal.runDir !== undefined ? { runDir: ctx.proposal.runDir } : {}),
      };
    },
    // Preserve the runDir produced by propose so the write leaf's logs can reference it.
    output: (ctx, out) => ({
      ...ctx,
      accepted: out.accepted,
      proposal: {
        ...out.proposal,
        ...(ctx.proposal?.runDir !== undefined ? { runDir: ctx.proposal.runDir } : {}),
      },
    }),
  });
