import type { Result } from '@src/domain/result.ts';
import type { AskConfirmInput, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';

/**
 * `InteractivePrompt` whose only live method is `askConfirm`: it records every message and replays
 * `responses` in order (throws once they run out). Every other method throws, so a leaf that asks
 * anything else fails loudly.
 */
export const scriptedConfirm = (
  responses: ReadonlyArray<Result<boolean, DomainError>> = []
): { readonly prompt: InteractivePrompt; readonly messages: readonly string[] } => {
  const messages: string[] = [];
  let next = 0;
  const notStubbed = (method: string) => async (): Promise<never> => {
    throw new Error(`${method} not stubbed on this fake`);
  };
  const prompt: InteractivePrompt = {
    askText: notStubbed('askText'),
    askTextArea: notStubbed('askTextArea'),
    askChoice: notStubbed('askChoice'),
    askMultiChoice: notStubbed('askMultiChoice'),
    askConfirm: async (input: AskConfirmInput) => {
      messages.push(input.message);
      const response = responses[next];
      next += 1;
      if (response === undefined) throw new Error('scriptedConfirm: no more scripted responses');
      return response;
    },
  };
  return { prompt, messages };
};
