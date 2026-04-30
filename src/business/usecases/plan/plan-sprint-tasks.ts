/**
 * `PlanSprintTasksUseCase` — drive an AI session that emits the task set
 * for a draft sprint and return the parsed `Task` list. Replan is built in:
 * pass `existingTasks` so the AI sees the prior set as context.
 *
 * Single-responsibility on purpose. Saving the new tasks, cleaning up
 * abandoned ones, and re-ordering by dependencies are chain-layer
 * concerns — this class only owns the AI round-trip + parse. The parser
 * lives in {@link ./task-list-parser.ts} so this file stays focused on
 * orchestration.
 */
import type { Sprint } from '../../../domain/entities/sprint.ts';
import type { Task } from '../../../domain/entities/task.ts';
import type { DomainError } from '../../../domain/errors/domain-error.ts';
import { InvalidStateError } from '../../../domain/errors/invalid-state-error.ts';
import { Result } from '../../../domain/result.ts';
import type { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import type { AiSessionPort } from '../../ports/ai-session-port.ts';
import type { LoggerPort } from '../../ports/logger-port.ts';
import type { PromptBuilderPort } from '../../ports/prompt-builder-port.ts';
import { parseTaskList } from './task-list-parser.ts';

/** Inputs to {@link PlanSprintTasksUseCase}. */
export interface PlanSprintTasksInput {
  /** Loaded sprint — must be `draft`, all tickets `approved`. */
  readonly sprint: Sprint;
  /** Tasks from a prior plan run. `[]` for an initial plan. */
  readonly existingTasks: readonly Task[];
  /** Working directory for the AI session. */
  readonly cwd: AbsolutePath;
  /** Optional cooperative cancellation. */
  readonly abortSignal?: AbortSignal;
}

/** Outputs from {@link PlanSprintTasksUseCase}. */
export interface PlanSprintTasksOutput {
  /** New task set. Replaces all existing tasks atomically (caller saves). */
  readonly tasks: readonly Task[];
  /** Raw AI stdout — kept for diagnostics. */
  readonly rawAiOutput: string;
}

export class PlanSprintTasksUseCase {
  constructor(
    private readonly ai: AiSessionPort,
    private readonly prompts: PromptBuilderPort,
    private readonly logger: LoggerPort
  ) {}

  async execute(input: PlanSprintTasksInput): Promise<Result<PlanSprintTasksOutput, DomainError>> {
    if (input.sprint.status !== 'draft') {
      return Result.error(
        new InvalidStateError({
          entity: 'sprint',
          currentState: input.sprint.status,
          attemptedAction: 'plan',
        })
      );
    }

    if (input.sprint.tickets.length === 0 || !input.sprint.hasApprovedAllTickets()) {
      return Result.error(
        new InvalidStateError({
          entity: 'sprint',
          currentState: 'tickets-not-approved',
          attemptedAction: 'plan',
        })
      );
    }

    const log = this.logger.child({ sprintId: input.sprint.id });

    const promptResult = await this.prompts.buildPlanPrompt({
      sprint: input.sprint,
      existingTasks: input.existingTasks,
    });
    if (!promptResult.ok) return Result.error(promptResult.error);

    log.info('planning tasks', {
      tickets: input.sprint.tickets.length,
      replan: input.existingTasks.length > 0,
    });

    const sessionResult = await this.ai.spawnHeadless(promptResult.value, {
      cwd: input.cwd,
      ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
    });
    if (!sessionResult.ok) return Result.error(sessionResult.error);

    const parsed = parseTaskList(sessionResult.value.output);
    if (!parsed.ok) return Result.error(parsed.error);

    return Result.ok({
      tasks: parsed.value,
      rawAiOutput: sessionResult.value.output,
    });
  }
}
