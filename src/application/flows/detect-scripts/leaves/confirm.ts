import { Result } from '@src/domain/result.ts';
import type { Choice, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { VerifyGateProposal } from '@src/domain/signal.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { readRunBodyPreview } from '@src/integration/ai/runs/_engine/run-artifacts.ts';
import type { DetectScriptsCtx } from '@src/application/flows/detect-scripts/ctx.ts';

export interface ConfirmDetectScriptsLeafDeps {
  readonly interactive: InteractivePrompt;
}

interface ConfirmInput {
  readonly repository: Repository;
  readonly proposal: {
    readonly proposedSetupScript?: string;
    readonly proposedVerifyScript?: string;
    readonly proposedVerifyGates?: readonly VerifyGateProposal[];
  };
  /**
   * Per-run forensic dir under `<runsRoot>/detect-scripts/<run-id>/`. The empty-proposal branch
   * reads `body.txt` inside it (when present) and surfaces a preview so the user sees the AI's
   * actual response — e.g. a permission request — instead of just "no proposals". `undefined`
   * means propose didn't write artifacts (shouldn't happen on the happy path, but the empty
   * branch degrades gracefully without it).
   */
  readonly runDir?: AbsolutePath;
}

interface ConfirmOutput {
  readonly accepted: boolean;
  /**
   * The (possibly edited) proposal that should land on the repository. Equal to the input
   * proposal when the user approved as-is; carries the user's edits when they picked
   * "Edit & approve"; unused when `accepted === false` (write leaf no-ops).
   *
   * `proposedVerifyGates` is carried verbatim through approve / edit — gates are a structured
   * map that an inline single-line text editor cannot meaningfully tweak, so they ride along
   * with the proposal (approved or rejected wholesale) and only the legacy `verifyScript`
   * fallback is line-editable. The empty-proposal manual-entry branch never synthesises gates.
   */
  readonly proposal: {
    readonly proposedSetupScript?: string;
    readonly proposedVerifyScript?: string;
    readonly proposedVerifyGates?: readonly VerifyGateProposal[];
  };
}

type Decision = 'approve' | 'edit' | 'reject';
type EmptyDecision = 'manual' | 'skip';

/**
 * Render the proposal as a preview and ask the user to approve / edit / reject:
 *
 *   - Approve         → keep the AI's proposal verbatim, transition `accepted: true`.
 *   - Edit & approve  → prompt for each non-empty proposed script with the AI's value
 *                       pre-filled; user tweaks, submits; edited proposal lands on ctx.
 *                       Submitting an empty buffer drops that script from the proposal
 *                       (treated as "don't apply this one"). `accepted: true` if at least
 *                       one script survives editing, `false` otherwise.
 *   - Reject          → leave the repository entity untouched (`accepted: false`).
 *
 * Diffing against existing `Repository.setupScript` / `verifyScript` is shown inline so the user
 * sees what they're changing — empty existing values render as `(none)`.
 *
 * Edge case — no proposed scripts at all: the user is still queried with an "Enter manually /
 * Skip" choice so they're never silently no-op'd. Manual entry pre-fills any existing values.
 */

/**
 * Handle the case where the AI returned no proposals: show the raw body when available,
 * then offer manual entry or skip. Manual entry pre-fills any existing values and returns
 * the user's input; skip returns an empty proposal with `accepted: false`.
 */
const handleEmptyProposal = async (
  deps: ConfirmDetectScriptsLeafDeps,
  input: ConfirmInput
): Promise<Result<ConfirmOutput, DomainError>> => {
  const bodyPreview =
    input.runDir !== undefined
      ? await readRunBodyPreview(input.runDir, {
          truncatedSuffix: `\n[…truncated; full body at ${String(input.runDir)}/body.txt]`,
        })
      : undefined;
  const header = `AI returned no proposals for ${input.repository.name} (${String(input.repository.slug)}).`;
  const promptLines: string[] = [header];
  if (bodyPreview !== undefined) {
    promptLines.push('', 'AI response:', bodyPreview);
  } else if (input.runDir !== undefined) {
    promptLines.push('', `Run artifacts: ${String(input.runDir)}`);
  }
  promptLines.push('', 'What would you like to do?');

  const emptyChoices: ReadonlyArray<Choice<EmptyDecision>> = [
    { label: 'Enter manually', value: 'manual', description: 'Type setup / verify scripts yourself.' },
    { label: 'Skip', value: 'skip', description: 'Leave the repository unchanged.' },
  ];
  const decision = await deps.interactive.askChoice<EmptyDecision>(promptLines.join('\n'), emptyChoices);
  if (!decision.ok) return Result.error(decision.error);
  if (decision.value === 'skip') {
    return Result.ok({ accepted: false, proposal: {} });
  }
  const manualSetup = await deps.interactive.askText('Setup script (empty to skip):', {
    ...(input.repository.setupScript !== undefined ? { initial: input.repository.setupScript } : {}),
  });
  if (!manualSetup.ok) return Result.error(manualSetup.error);
  const manualVerify = await deps.interactive.askText('Verify script (empty to skip):', {
    ...(input.repository.verifyScript !== undefined ? { initial: input.repository.verifyScript } : {}),
  });
  if (!manualVerify.ok) return Result.error(manualVerify.error);
  const setupOut = manualSetup.value.length > 0 ? manualSetup.value : undefined;
  const verifyOut = manualVerify.value.length > 0 ? manualVerify.value : undefined;
  const accepted = setupOut !== undefined || verifyOut !== undefined;
  return Result.ok({
    accepted,
    proposal: {
      ...(setupOut !== undefined ? { proposedSetupScript: setupOut } : {}),
      ...(verifyOut !== undefined ? { proposedVerifyScript: verifyOut } : {}),
    },
  });
};

/**
 * Build the diff preview showing current vs. next scripts and verify gates.
 * Pure function — no I/O or side effects.
 */
const buildProposalPreview = (
  nextSetup: string | undefined,
  nextVerify: string | undefined,
  nextGates: readonly VerifyGateProposal[] | undefined,
  currentSetup: string | undefined,
  currentVerify: string | undefined,
  repositoryName: string,
  repositorySlug: string
): string[] => {
  const preview: string[] = [`Detected scripts for ${repositoryName} (${repositorySlug}):`, ''];
  if (nextSetup !== undefined) {
    preview.push('Setup script (sprint-start prep):');
    preview.push(`  current: ${renderScript(currentSetup)}`);
    preview.push(`  next:    ${nextSetup}`);
    preview.push('');
  }
  if (nextVerify !== undefined) {
    preview.push('Verify script (post-task gate):');
    preview.push(`  current: ${renderScript(currentVerify)}`);
    preview.push(`  next:    ${nextVerify}`);
    preview.push('');
  }
  if (nextGates !== undefined && nextGates.length > 0) {
    preview.push('Per-module verify gates (monorepo — diff-scoped, win over the verify script):');
    for (const gate of nextGates) {
      const scope = gate.pathPrefix.length > 0 ? gate.pathPrefix : '(all — cross-module)';
      const timeout = gate.timeoutMs !== undefined ? ` [timeout ${String(gate.timeoutMs)}ms]` : '';
      preview.push(`  ${scope} → ${gate.command}${timeout}`);
    }
    preview.push('');
  }
  return preview;
};

/**
 * Handle the 'Edit & approve' flow: prompt for edits to each proposed script,
 * drop empty ones, and carry gates verbatim. Gates are not line-editable but
 * count toward acceptance even if script lines are dropped.
 */
const handleEditDecision = async (
  deps: ConfirmDetectScriptsLeafDeps,
  nextSetup: string | undefined,
  nextVerify: string | undefined,
  nextGates: readonly VerifyGateProposal[] | undefined
): Promise<Result<ConfirmOutput, DomainError>> => {
  let editedSetup: string | undefined;
  if (nextSetup !== undefined) {
    const answer = await deps.interactive.askText('Edit setup script (empty to drop):', { initial: nextSetup });
    if (!answer.ok) return Result.error(answer.error);
    if (answer.value.length > 0) editedSetup = answer.value;
  }
  let editedVerify: string | undefined;
  if (nextVerify !== undefined) {
    const answer = await deps.interactive.askText('Edit verify script (empty to drop):', { initial: nextVerify });
    if (!answer.ok) return Result.error(answer.error);
    if (answer.value.length > 0) editedVerify = answer.value;
  }

  const keepGates = nextGates !== undefined && nextGates.length > 0;
  const accepted = editedSetup !== undefined || editedVerify !== undefined || keepGates;
  return Result.ok({
    accepted,
    proposal: {
      ...(editedSetup !== undefined ? { proposedSetupScript: editedSetup } : {}),
      ...(editedVerify !== undefined ? { proposedVerifyScript: editedVerify } : {}),
      ...(keepGates ? { proposedVerifyGates: nextGates } : {}),
    },
  });
};

const confirmUseCase = async (
  deps: ConfirmDetectScriptsLeafDeps,
  input: ConfirmInput
): Promise<Result<ConfirmOutput, DomainError>> => {
  const {
    proposedSetupScript: nextSetup,
    proposedVerifyScript: nextVerify,
    proposedVerifyGates: nextGates,
  } = input.proposal;

  if (nextSetup === undefined && nextVerify === undefined) {
    return handleEmptyProposal(deps, input);
  }

  const currentSetup = input.repository.setupScript;
  const currentVerify = input.repository.verifyScript;
  const preview = buildProposalPreview(
    nextSetup,
    nextVerify,
    nextGates,
    currentSetup,
    currentVerify,
    input.repository.name,
    String(input.repository.slug)
  );

  const choices: ReadonlyArray<Choice<Decision>> = [
    { label: 'Approve', value: 'approve', description: 'Apply the proposal as-is.' },
    { label: 'Edit & approve', value: 'edit', description: 'Tweak each line, then apply.' },
    { label: 'Reject', value: 'reject', description: 'Leave the repository unchanged.' },
  ];

  const decision = await deps.interactive.askChoice<Decision>(
    `${preview.join('\n')}\nWhat would you like to do?`,
    choices
  );
  if (!decision.ok) return Result.error(decision.error);

  if (decision.value === 'reject') {
    return Result.ok({ accepted: false, proposal: {} });
  }
  if (decision.value === 'approve') {
    return Result.ok({
      accepted: true,
      proposal: {
        ...(nextSetup !== undefined ? { proposedSetupScript: nextSetup } : {}),
        ...(nextVerify !== undefined ? { proposedVerifyScript: nextVerify } : {}),
        ...(nextGates !== undefined && nextGates.length > 0 ? { proposedVerifyGates: nextGates } : {}),
      },
    });
  }

  return handleEditDecision(deps, nextSetup, nextVerify, nextGates);
};

const renderScript = (script: string | undefined): string => (script === undefined ? '(none)' : script);

export const confirmDetectScriptsLeaf = (deps: ConfirmDetectScriptsLeafDeps): Element<DetectScriptsCtx> =>
  leaf<DetectScriptsCtx, ConfirmInput, ConfirmOutput>('confirm', {
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
          ...(ctx.proposal.proposedSetupScript !== undefined
            ? { proposedSetupScript: ctx.proposal.proposedSetupScript }
            : {}),
          ...(ctx.proposal.proposedVerifyScript !== undefined
            ? { proposedVerifyScript: ctx.proposal.proposedVerifyScript }
            : {}),
          ...(ctx.proposal.proposedVerifyGates !== undefined
            ? { proposedVerifyGates: ctx.proposal.proposedVerifyGates }
            : {}),
        },
        ...(ctx.proposal.runDir !== undefined ? { runDir: ctx.proposal.runDir } : {}),
      };
    },
    // The runDir produced by propose is preserved on ctx for write-leaf logs; everything else
    // in the proposal is owned by confirm's output (Edit & approve can drop a previously-set
    // field, so we must NOT carry the old script values forward).
    output: (ctx, out) => ({
      ...ctx,
      accepted: out.accepted,
      proposal: {
        ...out.proposal,
        ...(ctx.proposal?.runDir !== undefined ? { runDir: ctx.proposal.runDir } : {}),
      },
    }),
  });
