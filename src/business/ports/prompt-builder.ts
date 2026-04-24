import type { Task } from '@src/domain/models.ts';

/** Port for building AI prompts for each workflow phase */
export interface PromptBuilderPort {
  /** Build prompt for ticket requirement refinement */
  buildRefinePrompt(ticketContent: string, outputFile: string, schema: string, issueContext?: string): string;

  /** Build prompt for sprint planning (headless/auto mode) */
  buildPlanAutoPrompt(context: string, schema: string, projectToolingSection?: string): string;

  /** Build prompt for sprint planning (interactive mode) */
  buildPlanInteractivePrompt(
    context: string,
    outputFile: string,
    schema: string,
    projectToolingSection?: string
  ): string;

  /** Build prompt for ideation (headless/auto mode) */
  buildIdeateAutoPrompt(context: string, schema: string, projectToolingSection?: string): string;

  /** Build prompt for ideation (interactive mode) */
  buildIdeateInteractivePrompt(
    context: string,
    outputFile: string,
    schema: string,
    projectToolingSection?: string
  ): string;

  /**
   * Build the task-execution instructions prompt.
   *
   * The returned string is the "## Instructions" block written INTO the
   * per-task context file. The agent is then told (via the spawn prompt)
   * to read the context file and follow the instructions.
   *
   * @param progressFilePath — absolute path to `<sprintDir>/progress.md`;
   *   substituted into `{{PROGRESS_FILE}}` in the template so the agent
   *   reads/writes the real file.
   * @param contextFileName — basename of the per-task context file in the
   *   project directory; substituted into `{{CONTEXT_FILE}}`.
   * @param projectToolingSection — pre-rendered `## Project Tooling` block
   *   listing subagents / skills / MCP servers detected in the target
   *   repo; empty string when nothing was detected (the template handles
   *   empty substitution cleanly).
   * @param noCommit — when true, the template emits no "commit" step/
   *   constraint. Default false.
   */
  buildTaskExecutionPrompt(
    progressFilePath: string,
    contextFileName: string,
    projectToolingSection: string,
    noCommit?: boolean
  ): string;

  /**
   * Build prompt for task evaluation.
   *
   * @param task — the task being evaluated. `task.repoId` is the FK; the
   *   caller resolves it to an absolute path and passes it as `repoPath`.
   * @param repoPath — absolute path of the task's repo (resolved from
   *   `task.repoId` by the caller) — rendered into the evaluator prompt
   *   as `{{PROJECT_PATH}}`.
   * @param checkScriptSection — pre-rendered `#### Check Script (Computational Gate)`
   *   markdown block (or `null` when the repo has no `checkScript` configured).
   *   The H4 level is intentional — the evaluator template injects this under
   *   `### Phase 1`, so anything shallower would break the hierarchy.
   * @param projectToolingSection — pre-rendered `## Project Tooling` block
   *   listing subagents / skills / MCP servers available in the project; empty
   *   string when nothing was detected.
   */
  buildTaskEvaluationPrompt(
    task: Task,
    repoPath: string,
    checkScriptSection: string | null,
    projectToolingSection: string
  ): string;

  /**
   * Build the prompt used to resume the generator for a fix attempt after the
   * evaluator flagged issues. The returned string is the full
   * `task-evaluation-resume.md` template — signals, fix protocol, harness
   * context, optional commit instruction — so the generator knows how to
   * re-verify and signal completion. The caller is expected to pass the
   * result to `spawnWithRetry` with `resumeSessionId` set to the generator's
   * original session ID so the fix runs as a continuation of the initial
   * task session, not a fresh one.
   *
   * @param critique — full evaluator critique text; embedded verbatim into
   *   the `{{CRITIQUE}}` placeholder.
   * @param needsCommit — when true, the template instructs the generator to
   *   commit its fix before signaling completion. Mirrors the inverse of
   *   `ExecutionOptions.noCommit`.
   */
  buildTaskEvaluationResumePrompt(critique: string, needsCommit: boolean): string;

  /** Build prompt for sprint feedback implementation */
  buildFeedbackPrompt(sprintName: string, completedTasks: string, feedback: string, branch: string | null): string;
}
