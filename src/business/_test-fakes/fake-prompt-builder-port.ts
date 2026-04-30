/**
 * `FakePromptBuilderPort` — non-IO fake of {@link PromptBuilderPort}.
 *
 * Returns a deterministic, JSON-stringified summary of the input bag so
 * tests can assert that the right inputs reached the prompt layer without
 * coupling to the actual `.md` template content.
 *
 * The captured-input arrays let tests inspect what each builder method
 * was called with.
 */
import type { Sprint } from '../../domain/entities/sprint.ts';
import type { Task } from '../../domain/entities/task.ts';
import type { Ticket } from '../../domain/entities/ticket.ts';
import type { StorageError } from '../../domain/errors/storage-error.ts';
import { Result } from '../../domain/result.ts';
import type { BuildOnboardPromptInput, PromptBuilderPort } from '../ports/prompt-builder-port.ts';

export interface FakePromptBuilderOptions {
  /** When set, every builder method returns `Result.error(...)` with this error. */
  readonly failWith?: StorageError;
}

export class FakePromptBuilderPort implements PromptBuilderPort {
  readonly refineCalls: { ticket: Ticket }[] = [];
  readonly planCalls: { sprint: Sprint; existingTasks: readonly Task[] }[] = [];
  readonly ideateCalls: { sprint: Sprint; ideaText: string }[] = [];
  readonly executeCalls: { task: Task; sprint: Sprint }[] = [];
  readonly evaluateCalls: { task: Task; sprint: Sprint; previousCritique?: string }[] = [];
  readonly feedbackCalls: { sprint: Sprint; feedbackText: string }[] = [];
  readonly onboardCalls: BuildOnboardPromptInput[] = [];

  constructor(private readonly opts: FakePromptBuilderOptions = {}) {}

  buildRefinePrompt(input: { ticket: Ticket }): Promise<Result<string, StorageError>> {
    this.refineCalls.push(input);
    if (this.opts.failWith) return Promise.resolve(Result.error(this.opts.failWith));
    return Promise.resolve(Result.ok(`refine:${input.ticket.id}:${input.ticket.title}`));
  }

  buildPlanPrompt(input: { sprint: Sprint; existingTasks: readonly Task[] }): Promise<Result<string, StorageError>> {
    this.planCalls.push(input);
    if (this.opts.failWith) return Promise.resolve(Result.error(this.opts.failWith));
    return Promise.resolve(
      Result.ok(
        `plan:${input.sprint.id}:tickets=${String(input.sprint.tickets.length)}:existing=${String(input.existingTasks.length)}`
      )
    );
  }

  buildIdeatePrompt(input: { sprint: Sprint; ideaText: string }): Promise<Result<string, StorageError>> {
    this.ideateCalls.push(input);
    if (this.opts.failWith) return Promise.resolve(Result.error(this.opts.failWith));
    return Promise.resolve(Result.ok(`ideate:${input.sprint.id}:${input.ideaText}`));
  }

  buildExecutePrompt(input: { task: Task; sprint: Sprint }): Promise<Result<string, StorageError>> {
    this.executeCalls.push(input);
    if (this.opts.failWith) return Promise.resolve(Result.error(this.opts.failWith));
    return Promise.resolve(Result.ok(`execute:${input.task.id}`));
  }

  buildEvaluatePrompt(input: {
    task: Task;
    sprint: Sprint;
    previousCritique?: string;
  }): Promise<Result<string, StorageError>> {
    this.evaluateCalls.push(input);
    if (this.opts.failWith) return Promise.resolve(Result.error(this.opts.failWith));
    return Promise.resolve(Result.ok(`evaluate:${input.task.id}`));
  }

  buildFeedbackPrompt(input: { sprint: Sprint; feedbackText: string }): Promise<Result<string, StorageError>> {
    this.feedbackCalls.push(input);
    if (this.opts.failWith) return Promise.resolve(Result.error(this.opts.failWith));
    return Promise.resolve(Result.ok(`feedback:${input.sprint.id}:${input.feedbackText}`));
  }

  buildOnboardPrompt(input: BuildOnboardPromptInput): Promise<Result<string, StorageError>> {
    this.onboardCalls.push(input);
    if (this.opts.failWith) return Promise.resolve(Result.error(this.opts.failWith));
    return Promise.resolve(Result.ok(`onboard:${input.repoPath}:${input.fileName}:${input.mode}:${input.projectType}`));
  }
}
