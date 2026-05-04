/**
 * Onboard chain — post-AI HITL confirmation leaves.
 *
 * Steps covered: confirm-setup-script → confirm-verify-script → confirm-context-file
 *
 * These leaves present the AI's proposals to the user for review and
 * editing before anything is persisted. Each runs after `run-onboard-ai`
 * and before the write-side leaves. All three short-circuit when
 * `externallyManaged: true` or when no proposals are available.
 */
import { Result } from '@src/domain/result.ts';

import type { Element } from '@src/kernel/chain/element.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';
import type { OnboardRepoProposals } from '@src/business/usecases/onboard/onboard-repo.ts';
import type { ChainSharedDeps } from '@src/application/chains/chain-deps.ts';
import type { OnboardCtx } from './onboard-flow.ts';

/**
 * Prompt for a script value with the AI's suggestion pre-filled. Loops
 * until the user supplies a non-empty value — onboarding requires
 * concrete commands, not stub fields. Empty input falls back to the
 * suggestion when one exists; otherwise re-prompts with a hint.
 */
async function promptRequiredScript(
  prompt: ChainSharedDeps['prompt'],
  message: string,
  suggestion: string | null
): Promise<string> {
  const defaultValue = suggestion ?? '';
  let hint: string | null = null;
  for (;;) {
    const fullMessage = hint !== null ? `${message} — ${hint}` : message;
    const value = await prompt.input({ message: fullMessage, default: defaultValue });
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
    if (suggestion !== null && suggestion.trim().length > 0) return suggestion.trim();
    hint = 'value required';
  }
}

// ── confirm-setup-script ──────────────────────────────────────────────

export function confirmSetupScriptLeaf(deps: Pick<ChainSharedDeps, 'prompt'>): Element<OnboardCtx> {
  return new Leaf<
    OnboardCtx,
    {
      readonly proposals: OnboardRepoProposals | undefined;
      readonly autoAccept: boolean;
      readonly externallyManaged: boolean;
    },
    string | null | undefined
  >('confirm-setup-script', {
    useCase: {
      async execute(input) {
        if (input.externallyManaged || input.proposals === undefined) {
          // No proposal to confirm — short-circuit. `undefined` flows through
          // applyAcceptance() in save-repo-scripts as "leave existing unchanged".
          return Result.ok(undefined);
        }
        if (input.autoAccept) {
          return Result.ok(input.proposals.setupScript);
        }
        const accepted = await promptRequiredScript(
          deps.prompt,
          'Setup script (Enter to accept, edit to change)',
          input.proposals.setupScript
        );
        return Result.ok(accepted);
      },
    },
    input: (ctx) => ({
      proposals: ctx.proposals,
      autoAccept: ctx.autoAccept,
      externallyManaged: ctx.externallyManaged === true,
    }),
    output: (ctx, value) => ({ ...ctx, acceptedSetupScript: value }),
  });
}

// ── confirm-verify-script ─────────────────────────────────────────────

export function confirmVerifyScriptLeaf(deps: Pick<ChainSharedDeps, 'prompt'>): Element<OnboardCtx> {
  return new Leaf<
    OnboardCtx,
    {
      readonly proposals: OnboardRepoProposals | undefined;
      readonly autoAccept: boolean;
      readonly externallyManaged: boolean;
    },
    string | null | undefined
  >('confirm-verify-script', {
    useCase: {
      async execute(input) {
        if (input.externallyManaged || input.proposals === undefined) {
          return Result.ok(undefined);
        }
        if (input.autoAccept) {
          return Result.ok(input.proposals.verifyScript);
        }
        const accepted = await promptRequiredScript(
          deps.prompt,
          'Verify script (Enter to accept, edit to change)',
          input.proposals.verifyScript
        );
        return Result.ok(accepted);
      },
    },
    input: (ctx) => ({
      proposals: ctx.proposals,
      autoAccept: ctx.autoAccept,
      externallyManaged: ctx.externallyManaged === true,
    }),
    output: (ctx, value) => ({ ...ctx, acceptedVerifyScript: value }),
  });
}

// ── confirm-context-file ──────────────────────────────────────────────

export function confirmContextFileLeaf(deps: Pick<ChainSharedDeps, 'prompt'>): Element<OnboardCtx> {
  return new Leaf<
    OnboardCtx,
    {
      readonly proposals: OnboardRepoProposals | undefined;
      readonly autoAccept: boolean;
      readonly externallyManaged: boolean;
    },
    string | null | undefined
  >('confirm-context-file', {
    useCase: {
      async execute(input) {
        if (input.externallyManaged || input.proposals === undefined) {
          return Result.ok(null);
        }
        if (input.autoAccept) {
          return Result.ok(input.proposals.contextFileContent);
        }
        // Editor returns null on cancel — treat as "skip write".
        const edited = await deps.prompt.editor({
          message: `Project context file (${input.proposals.contextFilePath})`,
          default: input.proposals.contextFileContent ?? '',
          kind: 'markdown',
        });
        if (edited === null) return Result.ok(null);
        return Result.ok(edited.length === 0 ? null : edited);
      },
    },
    input: (ctx) => ({
      proposals: ctx.proposals,
      autoAccept: ctx.autoAccept,
      externallyManaged: ctx.externallyManaged === true,
    }),
    output: (ctx, value) => ({ ...ctx, acceptedContextFile: value ?? null }),
  });
}
