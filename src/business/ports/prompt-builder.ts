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

  /** Build prompt for task execution */
  buildTaskExecutionPrompt(task: Task, sprint: Sprint, context: string): string;

  /** Build prompt for task evaluation */
  buildTaskEvaluationPrompt(task: Task, sprint: Sprint, context: string): string;

  /** Build prompt for sprint feedback implementation */
  buildFeedbackPrompt(sprintName: string, completedTasks: string, feedback: string, branch: string | null): string;
}
