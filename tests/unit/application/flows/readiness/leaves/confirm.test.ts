import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { ReadinessCtx } from '@src/application/flows/readiness/ctx.ts';
import { confirmReadinessLeaf } from '@src/application/flows/readiness/leaves/confirm.ts';
import { absolutePath, FIXED_PROJECT_ID } from '@tests/fixtures/domain.ts';

const TOOL = 'claude-code' as const;

const notScripted = (): Result<never, DomainError> =>
  Result.error(new ValidationError({ field: 'fake', value: null, message: 'not scripted' }));

/** InteractivePrompt that answers every `askConfirm` with `answer` and records the message. */
const recordingPrompt = (answer: boolean): InteractivePrompt & { readonly messages: readonly string[] } => {
  const messages: string[] = [];
  return {
    messages,
    askText: async () => notScripted(),
    askTextArea: async () => notScripted(),
    askChoice: async () => notScripted(),
    askMultiChoice: async () => notScripted(),
    async askConfirm(input) {
      messages.push(input.message);
      return Result.ok(answer);
    },
  };
};

const ctxWith = (
  proposal: NonNullable<NonNullable<ReadinessCtx['entries'][typeof TOOL]>['proposal']>
): ReadinessCtx => ({
  projectId: FIXED_PROJECT_ID,
  tools: [TOOL],
  entries: { [TOOL]: { proposal } },
});

describe('confirm readiness leaf', () => {
  it('shows the setup and verify SKILL.md bodies that accepting will install', async () => {
    const prompt = recordingPrompt(true);
    const leaf = confirmReadinessLeaf({ interactive: prompt }, TOOL);

    const result = await leaf.execute(
      ctxWith({
        proposedContent: '# context body',
        targetPath: absolutePath('/tmp/repo/CLAUDE.md'),
        proposedSetupSkillBody: 'SETUP-SKILL-BODY: run the installer',
        proposedVerifySkillBody: 'VERIFY-SKILL-BODY: run the checks',
      })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.entries[TOOL]?.accepted).toBe(true);
    expect(prompt.messages).toHaveLength(1);
    const message = prompt.messages[0] ?? '';
    expect(message).toContain('# context body');
    expect(message).toContain('SETUP-SKILL-BODY: run the installer');
    expect(message).toContain('VERIFY-SKILL-BODY: run the checks');
  });

  it('omits the skill sections when the proposal carries no skill bodies', async () => {
    const prompt = recordingPrompt(false);
    const leaf = confirmReadinessLeaf({ interactive: prompt }, TOOL);

    const result = await leaf.execute(
      ctxWith({ proposedContent: '# context body', targetPath: absolutePath('/tmp/repo/CLAUDE.md') })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.entries[TOOL]?.accepted).toBe(false);
    expect(prompt.messages[0]).not.toContain('skill (installed as');
  });
});
