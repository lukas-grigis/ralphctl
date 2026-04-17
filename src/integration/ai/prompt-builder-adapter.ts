import type { PromptBuilderPort } from '@src/business/ports/prompt-builder.ts';
import type { Sprint, Task } from '@src/domain/models.ts';
import {
  buildTicketRefinePrompt,
  buildAutoPrompt,
  buildInteractivePrompt,
  buildTaskExecutionPrompt,
  buildEvaluatorPrompt,
  buildIdeateAutoPrompt,
  buildIdeatePrompt,
  buildSprintFeedbackPrompt,
} from '@src/integration/ai/prompts/loader.ts';

/**
 * Adapter wrapping prompt builder functions.
 *
 * Note: The existing prompt builder functions have different signatures than the
 * port interface. This adapter bridges the gap, but some methods require the
 * caller to pre-compose context before passing it. The port provides a
 * simplified API that hides provider-specific prompt composition details.
 */
export class TextPromptBuilderAdapter implements PromptBuilderPort {
  buildRefinePrompt(ticketContent: string, outputFile: string, schema: string, issueContext?: string): string {
    return buildTicketRefinePrompt(ticketContent, outputFile, schema, issueContext ?? '');
  }

  buildPlanAutoPrompt(context: string, schema: string, projectToolingSection?: string): string {
    return buildAutoPrompt(context, schema, projectToolingSection ?? '');
  }

  buildPlanInteractivePrompt(
    context: string,
    outputFile: string,
    schema: string,
    projectToolingSection?: string
  ): string {
    return buildInteractivePrompt(context, outputFile, schema, projectToolingSection ?? '');
  }

  buildIdeateAutoPrompt(context: string, schema: string, projectToolingSection?: string): string {
    // The existing buildIdeateAutoPrompt has a different signature (individual fields).
    // This adapter expects callers to pre-compose the context string.
    // We pass empty strings for the fields that are already embedded in context.
    return buildIdeateAutoPrompt('', '', '', '', schema, projectToolingSection ?? '');
  }

  buildIdeateInteractivePrompt(
    context: string,
    outputFile: string,
    schema: string,
    projectToolingSection?: string
  ): string {
    // Same as above — the existing function takes individual fields.
    return buildIdeatePrompt('', '', '', '', outputFile, schema, projectToolingSection ?? '');
  }

  buildTaskExecutionPrompt(progressFilePath: string, contextFileName: string, noCommit = false): string {
    return buildTaskExecutionPrompt(progressFilePath, noCommit, contextFileName);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  buildTaskEvaluationPrompt(task: Task, _sprint: Sprint, _context: string): string {
    return buildEvaluatorPrompt({
      taskName: task.name,
      taskDescription: task.description ?? '',
      taskSteps: task.steps,
      verificationCriteria: task.verificationCriteria,
      projectPath: task.projectPath,
      checkScriptSection: null,
      projectToolingSection: '',
    });
  }

  buildFeedbackPrompt(sprintName: string, completedTasks: string, feedback: string, branch: string | null): string {
    return buildSprintFeedbackPrompt(sprintName, completedTasks, feedback, branch);
  }
}
