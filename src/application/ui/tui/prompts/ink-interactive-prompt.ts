/**
 * `InteractivePrompt` adapter that pushes prompts onto the TUI's queue. Composition root passes
 * this to chain factories so use cases that call `interactive.ask*` end up rendering inside the
 * Ink tree instead of blocking the terminal with raw stdin reads.
 *
 * Cancellation surfaces through the `Result` channel as a `ValidationError` for input parsing
 * issues (matching the console adapter), and as an `AbortError` when the queue is drained
 * (e.g. on shutdown).
 */

import { Result } from '@src/domain/result.ts';
import type { AskConfirmInput, Choice, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { PromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';

const wrapError = (err: unknown, elementName: string): AbortError =>
  new AbortError({ elementName, reason: err instanceof Error ? err.message : 'prompt cancelled' });

export const createInkInteractivePrompt = (queue: PromptQueue): InteractivePrompt => ({
  async askText(prompt: string, opts?: { readonly initial?: string }): Promise<Result<string, DomainError>> {
    try {
      const value = await new Promise<string>((resolve, reject) => {
        queue.enqueue({
          kind: 'text',
          message: prompt,
          ...(opts?.initial !== undefined ? { initial: opts.initial } : {}),
          resolve,
          reject,
        });
      });
      return Result.ok(value.trim());
    } catch (err) {
      return Result.error(wrapError(err, 'interactive.text'));
    }
  },

  async askTextArea(prompt: string, opts?: { readonly initial?: string }): Promise<Result<string, DomainError>> {
    try {
      const value = await new Promise<string>((resolve, reject) => {
        queue.enqueue({
          kind: 'textarea',
          message: prompt,
          ...(opts?.initial !== undefined ? { initial: opts.initial } : {}),
          resolve,
          reject,
        });
      });
      // Preserve user formatting (newlines, leading indentation). The review flow embeds the
      // typed text into a markdown round and trailing whitespace would shift the round body.
      return Result.ok(value);
    } catch (err) {
      return Result.error(wrapError(err, 'interactive.textarea'));
    }
  },

  async askChoice<T>(prompt: string, options: ReadonlyArray<Choice<T>>): Promise<Result<T, DomainError>> {
    if (options.length === 0) {
      return Result.error(wrapError(new Error('askChoice requires at least one option'), 'interactive.choice'));
    }
    try {
      const value = await new Promise<T>((resolve, reject) => {
        queue.enqueue({
          kind: 'choice',
          message: prompt,
          options: options as ReadonlyArray<Choice<unknown>>,
          resolve: (v: unknown) => resolve(v as T),
          reject,
        });
      });
      return Result.ok(value) as Result<T, DomainError>;
    } catch (err) {
      return Result.error(wrapError(err, 'interactive.choice'));
    }
  },

  async askMultiChoice<T>(
    prompt: string,
    options: ReadonlyArray<Choice<T>>
  ): Promise<Result<readonly T[], DomainError>> {
    if (options.length === 0) return Result.ok([]) as Result<readonly T[], DomainError>;
    try {
      const value = await new Promise<readonly T[]>((resolve, reject) => {
        queue.enqueue({
          kind: 'multi-choice',
          message: prompt,
          options: options as ReadonlyArray<Choice<unknown>>,
          resolve: (v: readonly unknown[]) => resolve(v as readonly T[]),
          reject,
        });
      });
      return Result.ok(value) as Result<readonly T[], DomainError>;
    } catch (err) {
      return Result.error(wrapError(err, 'interactive.multi-choice'));
    }
  },

  async askConfirm(input: AskConfirmInput): Promise<Result<boolean, DomainError>> {
    try {
      const value = await new Promise<boolean>((resolve, reject) => {
        queue.enqueue({ kind: 'confirm', message: input.message, resolve, reject });
      });
      return Result.ok(value);
    } catch (err) {
      return Result.error(wrapError(err, 'interactive.confirm'));
    }
  },
});
