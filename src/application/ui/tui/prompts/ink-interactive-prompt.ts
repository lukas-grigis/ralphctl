/** `InteractivePrompt` adapter that pushes prompts onto the TUI's queue. */

import { Result } from '@src/domain/result.ts';
import type { AskConfirmInput, AskTextOptions, Choice, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { currentRunSignal, rootSessionId } from '@src/application/session/session.ts';
import type { PendingPromptInput, PromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';

type Enqueuer = Pick<PromptQueue, 'enqueue'>;

const wrapError = (err: unknown, elementName: string): AbortError =>
  new AbortError({ elementName, reason: err instanceof Error ? err.message : 'prompt cancelled' });

const runAskText = async (
  queue: Enqueuer,
  prompt: string,
  opts?: AskTextOptions
): Promise<Result<string, DomainError>> => {
  try {
    const value = await new Promise<string>((resolve, reject) => {
      queue.enqueue({
        kind: 'text',
        message: prompt,
        ...(opts?.initial !== undefined ? { initial: opts.initial } : {}),
        ...(opts?.validate !== undefined ? { validate: opts.validate } : {}),
        resolve,
        reject,
      });
    });
    return Result.ok(value.trim());
  } catch (err) {
    return Result.error(wrapError(err, 'interactive.text'));
  }
};

const runAskTextArea = async (
  queue: Enqueuer,
  prompt: string,
  opts?: { readonly initial?: string }
): Promise<Result<string, DomainError>> => {
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
};

const runAskChoice = async <T>(
  queue: Enqueuer,
  prompt: string,
  options: ReadonlyArray<Choice<T>>
): Promise<Result<T, DomainError>> => {
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
};

const runAskMultiChoice = async <T>(
  queue: Enqueuer,
  prompt: string,
  options: ReadonlyArray<Choice<T>>,
  opts?: { readonly initial?: readonly T[] }
): Promise<Result<readonly T[], DomainError>> => {
  if (options.length === 0) return Result.ok([]) as Result<readonly T[], DomainError>;
  try {
    const value = await new Promise<readonly T[]>((resolve, reject) => {
      queue.enqueue({
        kind: 'multi-choice',
        message: prompt,
        options: options as ReadonlyArray<Choice<unknown>>,
        ...(opts?.initial !== undefined ? { initial: opts.initial as readonly unknown[] } : {}),
        resolve: (v: readonly unknown[]) => resolve(v as readonly T[]),
        reject,
      });
    });
    return Result.ok(value) as Result<readonly T[], DomainError>;
  } catch (err) {
    return Result.error(wrapError(err, 'interactive.multi-choice'));
  }
};

const runAskConfirm = async (queue: Enqueuer, input: AskConfirmInput): Promise<Result<boolean, DomainError>> => {
  try {
    const value = await new Promise<boolean>((resolve, reject) => {
      queue.enqueue({
        kind: 'confirm',
        message: input.message,
        ...(input.defaultValue !== undefined ? { defaultValue: input.defaultValue } : {}),
        resolve,
        reject,
      });
    });
    return Result.ok(value);
  } catch (err) {
    return Result.error(wrapError(err, 'interactive.confirm'));
  }
};

/** An unanswered question must not hold a stopping run open: the run's abort withdraws its prompt. */
const enqueueAbortable = (queue: PromptQueue, prompt: PendingPromptInput, signal: AbortSignal | undefined) => {
  if (signal === undefined) return queue.enqueue(prompt);
  const withdraw = (): void => queue.reject(queued.id, new Error('run aborted while waiting for an answer'));
  const detach = (): void => signal.removeEventListener('abort', withdraw);
  const settling = {
    ...prompt,
    resolve: (value: never) => {
      detach();
      (prompt.resolve as (v: unknown) => void)(value);
    },
    reject: (err: Error) => {
      detach();
      prompt.reject(err);
    },
  } as PendingPromptInput;
  const queued = queue.enqueue(settling);
  if (signal.aborted) withdraw();
  else signal.addEventListener('abort', withdraw, { once: true });
  return queued;
};

/** Stamps the asking run's id onto every prompt and announces it on the bus (OS "waiting on you" ping). */
const stampingEnqueuer = (queue: PromptQueue, eventBus: EventBus | undefined): Enqueuer => ({
  enqueue(prompt) {
    const sessionId = rootSessionId();
    // Only a run's prompt pings; a foreground picker has the operator's attention already.
    if (sessionId !== undefined) {
      eventBus?.publish({ type: 'awaiting-input', message: prompt.message, sessionId, at: IsoTimestamp.now() });
    }
    return enqueueAbortable(queue, sessionId !== undefined ? { ...prompt, sessionId } : prompt, currentRunSignal());
  },
});

export const createInkInteractivePrompt = (rawQueue: PromptQueue, eventBus?: EventBus): InteractivePrompt => {
  const queue = stampingEnqueuer(rawQueue, eventBus);
  return {
    askText: (prompt, opts) => runAskText(queue, prompt, opts),
    askTextArea: (prompt, opts) => runAskTextArea(queue, prompt, opts),
    askChoice<T>(prompt: string, options: ReadonlyArray<Choice<T>>): Promise<Result<T, DomainError>> {
      return runAskChoice(queue, prompt, options);
    },
    askMultiChoice<T>(
      prompt: string,
      options: ReadonlyArray<Choice<T>>,
      opts?: { readonly initial?: readonly T[] }
    ): Promise<Result<readonly T[], DomainError>> {
      return runAskMultiChoice(queue, prompt, options, opts);
    },
    askConfirm: (input) => runAskConfirm(queue, input),
  };
};
