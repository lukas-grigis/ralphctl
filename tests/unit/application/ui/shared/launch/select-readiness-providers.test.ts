/**
 * Launch-time provider scoping for the readiness flow.
 *
 * `selectReadinessProviders` is the prompt the launcher runs after `checkCli` and before it
 * constructs the runner. It is tested in isolation (rather than through `launchReadiness`)
 * because the launcher's own `checkCli` runs a real PATH probe — undesirable in a deterministic
 * unit test. The launcher wiring (caches / tools / flow opts built from the returned scope) is
 * a thin pass-through asserted by the `createReadinessFlow` scoping tests in the fan-out suite.
 *
 * Behaviours pinned here:
 *  1. multi-provider config → the picker IS shown; picking one provider scopes to `[that]`.
 *  2. multi-provider config → picking "All providers" returns every configured provider.
 *  3. single-provider config → the picker is NOT shown (askChoice must not be called); the lone
 *     provider is the implicit scope.
 *  4. cancel at the picker (AbortError, `.ok === false`) → `{ cancelled: true }` so the launcher
 *     returns its "do not launch" result.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { selectReadinessProviders } from '@src/application/ui/shared/launch/readiness.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';
import type { Choice, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';

/**
 * Build an `InteractivePrompt` whose `askChoice` records every call and returns a scripted
 * answer. `answer` receives the offered choices so a test can pick by value without restating
 * the option list. A throwing answer (default) proves the prompt is never invoked.
 */
const recordingChoice = (
  answer: (choices: ReadonlyArray<Choice<unknown>>) => Result<unknown, DomainError> = () => {
    throw new Error('askChoice should not have been called');
  }
): { interactive: InteractivePrompt; calls: Array<{ message: string; choices: ReadonlyArray<Choice<unknown>> }> } => {
  const calls: Array<{ message: string; choices: ReadonlyArray<Choice<unknown>> }> = [];
  const interactive: InteractivePrompt = {
    async askText(): Promise<never> {
      throw new Error('askText not used');
    },
    async askTextArea(): Promise<never> {
      throw new Error('askTextArea not used');
    },
    async askChoice<T>(message: string, choices: ReadonlyArray<Choice<T>>): Promise<Result<T, DomainError>> {
      calls.push({ message, choices: choices as ReadonlyArray<Choice<unknown>> });
      return answer(choices as ReadonlyArray<Choice<unknown>>) as Result<T, DomainError>;
    },
    async askMultiChoice(): Promise<never> {
      throw new Error('askMultiChoice not used');
    },
    async askConfirm(): Promise<never> {
      throw new Error('askConfirm not used');
    },
  };
  return { interactive, calls };
};

const ALL: readonly AiProvider[] = ['claude-code', 'github-copilot', 'openai-codex'];

describe('selectReadinessProviders', () => {
  it('multi-provider config → prompts and scopes to the single picked provider', async () => {
    const { interactive, calls } = recordingChoice((choices) => {
      const copilot = choices.find((c) => c.value === 'github-copilot');
      if (copilot === undefined) throw new Error('expected a github-copilot choice');
      return Result.ok(copilot.value);
    });

    const selection = await selectReadinessProviders(ALL, interactive);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.message).toContain('Which AI provider');
    expect(selection).toEqual({ cancelled: false, providers: ['github-copilot'] });
  });

  it('multi-provider config → picking "All providers" returns every configured provider', async () => {
    const { interactive } = recordingChoice((choices) => {
      const all = choices.find((c) => c.label === 'All providers');
      if (all === undefined) throw new Error('expected an "All providers" choice');
      return Result.ok(all.value);
    });

    const selection = await selectReadinessProviders(ALL, interactive);

    expect(selection).toEqual({ cancelled: false, providers: ALL });
  });

  it('single-provider config → no prompt; the lone provider is the implicit scope', async () => {
    // The default throwing `answer` asserts askChoice is never called.
    const { interactive, calls } = recordingChoice();

    const selection = await selectReadinessProviders(['claude-code'], interactive);

    expect(calls).toHaveLength(0);
    expect(selection).toEqual({ cancelled: false, providers: ['claude-code'] });
  });

  it('zero providers → no prompt; empty implicit scope (defensive)', async () => {
    const { interactive, calls } = recordingChoice();

    const selection = await selectReadinessProviders([], interactive);

    expect(calls).toHaveLength(0);
    expect(selection).toEqual({ cancelled: false, providers: [] });
  });

  it('cancel at the picker (AbortError) → cancelled, no scope', async () => {
    const { interactive } = recordingChoice(() =>
      Result.error(new AbortError({ elementName: 'select-readiness-providers', reason: 'user pressed Esc' }))
    );

    const selection = await selectReadinessProviders(ALL, interactive);

    expect(selection).toEqual({ cancelled: true });
  });
});
