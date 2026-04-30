/**
 * `PromptBuilderPort` — compiles `.md` prompt templates with placeholder
 * substitution. The full compile surface is exposed as one method per
 * workflow phase so business code never reaches into template internals.
 *
 * Each method accepts a typed input bag and returns the fully rendered
 * prompt string. Adapters load the matching `.md` template from
 * `integration/ai/prompts/` and substitute placeholders; failures
 * (missing template, unresolved placeholder) surface as a `StorageError`.
 */
import type { Sprint } from '../../domain/entities/sprint.ts';
import type { Task } from '../../domain/entities/task.ts';
import type { Ticket } from '../../domain/entities/ticket.ts';
import type { StorageError } from '../../domain/errors/storage-error.ts';
import type { Result } from '../../domain/result.ts';
import type { AbsolutePath } from '../../domain/values/absolute-path.ts';

/**
 * Onboarding mode discriminator — drives the prompt's posture toward an
 * existing project context file.
 *
 *  - `bootstrap` — no prior file at the target path; emit a fresh body.
 *  - `adopt`     — authored file present without the harness marker;
 *                  treat the existing body as authoritative and propose
 *                  additions only.
 *  - `update`    — prior harness-managed file present; emit a full
 *                  replacement plus a `<changes>` delta.
 */
export type OnboardMode = 'bootstrap' | 'adopt' | 'update';

/**
 * Inputs to {@link PromptBuilderPort.buildOnboardPrompt}. The adapter
 * substitutes one placeholder per field — optional fields render as the
 * empty string when omitted, never the literal "undefined".
 */
export interface BuildOnboardPromptInput {
  /** Absolute path to the repository being onboarded. */
  readonly repoPath: AbsolutePath;
  /**
   * Provider-native target file (`CLAUDE.md` for Claude,
   * `.github/copilot-instructions.md` for Copilot). The harness writes
   * the proposal here after user review.
   */
  readonly fileName: string;
  readonly mode: OnboardMode;
  /**
   * Project-type hint inferred from heuristic detection
   * (`'node'`/`'python'`/`'go'`/`'rust'`/`'unknown'`/…). Drives the
   * prompt's tone but does not constrain the AI — it inspects the actual
   * repo on disk.
   */
  readonly projectType: string;
  /**
   * Static check-script suggestion from the heuristic detector. The
   * prompt may surface it as a starting point. Empty string when no
   * suggestion is available.
   */
  readonly checkScriptSuggestion?: string;
  /**
   * Existing project context file body, when one is present at the
   * target path. Used in `adopt` / `update` modes so the AI can cite
   * what's already authoritative.
   */
  readonly existingAgentsMd?: string;
}

export interface PromptBuilderPort {
  /** Build the per-ticket refinement prompt — drives WHAT, not HOW. */
  buildRefinePrompt(input: { ticket: Ticket }): Promise<Result<string, StorageError>>;

  /** Build the sprint planning prompt — generates tasks across approved tickets. */
  buildPlanPrompt(input: { sprint: Sprint; existingTasks: readonly Task[] }): Promise<Result<string, StorageError>>;

  /** Build the ideation prompt — quick path that combines refine + plan from a free-form idea. */
  buildIdeatePrompt(input: { sprint: Sprint; ideaText: string }): Promise<Result<string, StorageError>>;

  /** Build the per-task execution prompt — issued to the generator agent. */
  buildExecutePrompt(input: { task: Task; sprint: Sprint }): Promise<Result<string, StorageError>>;

  /**
   * Build the evaluator prompt — issued to an autonomous reviewer after a
   * task settles. `previousCritique` is non-empty on retry rounds so the
   * evaluator can grade against the prior round.
   */
  buildEvaluatePrompt(input: {
    task: Task;
    sprint: Sprint;
    previousCritique?: string;
  }): Promise<Result<string, StorageError>>;

  /** Build the end-of-sprint feedback prompt — implements user-supplied feedback as a follow-up pass. */
  buildFeedbackPrompt(input: { sprint: Sprint; feedbackText: string }): Promise<Result<string, StorageError>>;

  /**
   * Build the repo-onboarding prompt — drives a one-shot AI inventory pass
   * that proposes a project context file body, setup + verify scripts, and
   * optional skill suggestions. Results are surfaced via the structured
   * onboarding signals (`agents-md-proposal`, `setup-script`,
   * `verify-script`, `skill-suggestions`).
   */
  buildOnboardPrompt(input: BuildOnboardPromptInput): Promise<Result<string, StorageError>>;
}
