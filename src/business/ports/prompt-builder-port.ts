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
import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Task } from '@src/domain/entities/task.ts';
import type { Ticket } from '@src/domain/entities/ticket.ts';
import type { StorageError } from '@src/domain/errors/storage-error.ts';
import type { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';

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
  /**
   * Build the per-ticket refinement prompt — drives WHAT, not HOW.
   * `outputFilePath` is the absolute path the AI is told to write the
   * refined requirements JSON to. Required for interactive mode (the
   * harness reads the file after the AI session exits); optional for
   * headless mode where the prompt expects requirements on stdout.
   */
  buildRefinePrompt(input: {
    ticket: Ticket;
    outputFilePath?: string;
    /**
     * Optional pre-fetched issue context (title + body + comments)
     * formatted via `ExternalPort.formatIssueContext`. When provided,
     * the builder wraps it in `<context>...</context>` and injects it
     * into the prompt instead of the bare-link rendering. This is the
     * 0.5.0 behaviour — Claude sees the actual issue body, not just a URL.
     */
    issueContext?: string;
  }): Promise<Result<string, StorageError>>;

  /**
   * Build the sprint planning prompt — generates tasks across approved tickets.
   * `outputFilePath` is the absolute path the AI writes the tasks JSON to in
   * interactive mode; left undefined for headless (parsed from stdout).
   */
  buildPlanPrompt(input: {
    sprint: Sprint;
    existingTasks: readonly Task[];
    outputFilePath?: string;
  }): Promise<Result<string, StorageError>>;

  /** Build the ideation prompt — quick path that combines refine + plan from a free-form idea. */
  buildIdeatePrompt(input: { sprint: Sprint; ideaText: string }): Promise<Result<string, StorageError>>;

  /**
   * Build the per-task execution prompt — issued to the generator agent.
   *
   * The template embeds the full task body inline (name, description,
   * implementation steps, verification criteria, branch, check script,
   * environment status). The chain layer renders this prompt to a file
   * under `<sprintDir>/contexts/execute-<task-id>.md` and hands the AI
   * a thin wrapper that points at it — the prompt the AI reads is the
   * file body, not the wrapper.
   *
   * `checkScript` — when supplied, the prompt embeds the actual command
   * the harness will run as the post-task gate. When omitted, the prompt
   * states explicitly that no check script is configured for this repo
   * so the agent doesn't chase a missing command.
   */
  buildExecutePrompt(input: {
    task: Task;
    sprint: Sprint;
    checkScript?: string;
  }): Promise<Result<string, StorageError>>;

  /**
   * Build the evaluator prompt — issued to an autonomous reviewer after a
   * task settles. `previousCritique` is non-empty on retry rounds so the
   * evaluator can grade against the prior round.
   *
   * `evaluateWorkspaceDir` is the absolute path of the per-task evaluate
   * workspace (set by the per-task chain after `buildEvaluateWorkspace`
   * lands its contract pack on disk). When set, the rendered prompt
   * includes a `Contract files` section pointing the AI at upstream
   * artefacts (`requirements/`, `tasks.md`, `dimensions.md`,
   * `prior-evaluations/`, `project-context.md`). When unset, the section
   * collapses — used by the standalone `sprint evaluate` chain which
   * has no workspace.
   */
  buildEvaluatePrompt(input: {
    task: Task;
    sprint: Sprint;
    previousCritique?: string;
    evaluateWorkspaceDir?: string;
    /**
     * The single `done-criteria.md` bullet for this task — e.g.
     * `- **Task name** (\`<id>\`) — <criteria>`. When supplied the
     * evaluator prompt renders a `## Per-task done criteria` section
     * with the bullet so the AI has a stable, explicit definition of
     * "done" without re-deriving it from the specification each round.
     * Collapses to an empty string when absent (legacy sprint / no
     * workspace / standalone `sprint evaluate`).
     */
    doneCriteriaBullet?: string;
  }): Promise<Result<string, StorageError>>;

  /**
   * Build the end-of-sprint feedback prompt — implements user-supplied
   * feedback as a follow-up pass.
   *
   * `completedTasks` is the set of done tasks the harness has already
   * shipped on this sprint. The prompt renders them as context-only — the
   * AI's authoritative instruction is the feedback text. Pass an empty
   * array when the chain has nothing to offer (the prompt renders a
   * "no tasks completed" placeholder so the section doesn't collapse).
   */
  buildFeedbackPrompt(input: {
    sprint: Sprint;
    feedbackText: string;
    completedTasks: readonly Task[];
  }): Promise<Result<string, StorageError>>;

  /**
   * Build the repo-onboarding prompt — drives a one-shot AI inventory pass
   * that proposes a project context file body, setup + verify scripts, and
   * optional skill suggestions. Results are surfaced via the structured
   * onboarding signals (`agents-md-proposal`, `setup-script`,
   * `verify-script`, `skill-suggestions`).
   */
  buildOnboardPrompt(input: BuildOnboardPromptInput): Promise<Result<string, StorageError>>;
}
