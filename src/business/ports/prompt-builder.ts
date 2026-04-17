import type { Sprint, Task } from '@src/domain/models.ts';

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
   * @param noCommit — when true, the template emits no "commit" step/
   *   constraint. Default false.
   */
  buildTaskExecutionPrompt(progressFilePath: string, contextFileName: string, noCommit?: boolean): string;

  /** Build prompt for task evaluation */
  buildTaskEvaluationPrompt(task: Task, sprint: Sprint, context: string): string;

  /** Build prompt for sprint feedback implementation */
  buildFeedbackPrompt(sprintName: string, completedTasks: string, feedback: string, branch: string | null): string;
}
