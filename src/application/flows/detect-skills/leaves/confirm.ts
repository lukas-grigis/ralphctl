import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { Result } from '@src/domain/result.ts';
import type { Choice, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { DetectSkillsCtx } from '@src/application/flows/detect-skills/ctx.ts';

/** Max chars of body.txt shown inline in the empty-proposal prompt before truncation. */
const BODY_PREVIEW_LIMIT = 800;

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

const readBodyPreview = async (runDir: AbsolutePath | undefined): Promise<string | undefined> => {
  if (runDir === undefined) return undefined;
  try {
    const raw = await fs.readFile(join(String(runDir), 'body.txt'), 'utf8');
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;
    if (trimmed.length <= BODY_PREVIEW_LIMIT) return trimmed;
    return `${trimmed.slice(0, BODY_PREVIEW_LIMIT).trimEnd()}\n[…truncated; full body at ${String(runDir)}/body.txt]`;
  } catch {
    return undefined;
  }
};

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
 * Render the proposed bodies as a preview (chunked + headed by source label) and ask
 * approve / reject. Editing is out of scope here — skills are multi-paragraph markdown and
 * the `askText` prompt is single-line; trying to edit a 10-paragraph body line-by-line is
 * worse UX than re-running the flow with a tighter prompt. The user can also tweak the
 * persisted skill via the storage file once it lands.
 *
 * Edge case — no proposed skills at all: show the AI's actual body inline (e.g. a permission
 * request, a confused refusal) so the operator understands *why* nothing came back, then exit
 * with `accepted: false`. Manual authoring is genuinely impractical for multi-paragraph skills,
 * so the only action is acknowledge-and-skip; the run dir path is surfaced regardless so the
 * operator can dig deeper. Mirrors the detect-scripts failsafe.
 */
const confirmUseCase = async (
  deps: ConfirmDetectSkillsLeafDeps,
  input: ConfirmInput
): Promise<Result<ConfirmOutput, DomainError>> => {
  const { proposedSetupSkill: nextSetup, proposedVerifySkill: nextVerify } = input.proposal;

  if (nextSetup === undefined && nextVerify === undefined) {
    const bodyPreview = await readBodyPreview(input.runDir);
    const header = `AI returned no skill proposals for ${input.repository.name} (${String(input.repository.slug)}).`;
    const promptLines: string[] = [header];
    if (bodyPreview !== undefined) {
      promptLines.push('', 'AI response:', bodyPreview);
    } else if (input.runDir !== undefined) {
      promptLines.push('', `Run artifacts: ${String(input.runDir)}`);
    }
    promptLines.push('', 'Acknowledge and skip — the repository will be left untouched.');
    const choices: ReadonlyArray<Choice<EmptyDecision>> = [
      { label: 'Skip', value: 'skip', description: 'Continue without applying any skill.' },
    ];
    const decision = await deps.interactive.askChoice<EmptyDecision>(promptLines.join('\n'), choices);
    if (!decision.ok) return Result.error(decision.error);
    return Result.ok({ accepted: false, proposal: {} });
  }

  const currentSetup = input.repository.setupSkill;
  const currentVerify = input.repository.verifySkill;
  const preview: string[] = [`Authored skills for ${input.repository.name} (${String(input.repository.slug)}):`, ''];
  if (nextSetup !== undefined) {
    preview.push(`### Setup skill ${currentSetup !== undefined ? '(replaces existing)' : '(new)'}`);
    preview.push('');
    preview.push(nextSetup);
    preview.push('');
  }
  if (nextVerify !== undefined) {
    preview.push(`### Verify skill ${currentVerify !== undefined ? '(replaces existing)' : '(new)'}`);
    preview.push('');
    preview.push(nextVerify);
    preview.push('');
  }

  const choices: ReadonlyArray<Choice<Decision>> = [
    { label: 'Approve', value: 'approve', description: 'Save the proposed skill bodies to the repository.' },
    { label: 'Reject', value: 'reject', description: 'Leave the repository untouched.' },
  ];

  const decision = await deps.interactive.askChoice<Decision>(
    `${preview.join('\n')}\nWhat would you like to do?`,
    choices
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
