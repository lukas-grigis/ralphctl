/**
 * `RefineSingleTicketUseCase` — drives one HITL refinement pass for a
 * single ticket via a headless AI session and returns the updated
 * `Ticket` (still `pending` → `approved`).
 *
 * Single-responsibility on purpose: looping over the sprint's pending
 * tickets, persistence, and user confirmation are chain-layer concerns.
 * This class only owns the AI round-trip + entity transition.
 */
import type { Sprint } from '../../../domain/entities/sprint.ts';
import { Ticket } from '../../../domain/entities/ticket.ts';
import type { DomainError } from '../../../domain/errors/domain-error.ts';
import { InvalidStateError } from '../../../domain/errors/invalid-state-error.ts';
import { Result } from '../../../domain/result.ts';
import type { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import type { AiSessionPort } from '../../ports/ai-session-port.ts';
import type { LoggerPort } from '../../ports/logger-port.ts';
import type { PromptBuilderPort } from '../../ports/prompt-builder-port.ts';

/** Inputs to {@link RefineSingleTicketUseCase}. */
export interface RefineSingleTicketInput {
  /** Loaded sprint — caller has already passed the draft / state guard. */
  readonly sprint: Sprint;
  /** Ticket to refine. Must be `requirementStatus === 'pending'`. */
  readonly ticket: Ticket;
  /** Working directory for the AI session. */
  readonly cwd: AbsolutePath;
  /** Optional cooperative cancellation. */
  readonly abortSignal?: AbortSignal;
}

/** Outputs from {@link RefineSingleTicketUseCase}. */
export interface RefineSingleTicketOutput {
  /** Updated ticket with requirements text and `approved` status. */
  readonly ticket: Ticket;
  /** Raw AI stdout — kept for diagnostics / signal parsing downstream. */
  readonly rawAiOutput: string;
}

export class RefineSingleTicketUseCase {
  constructor(
    private readonly ai: AiSessionPort,
    private readonly prompts: PromptBuilderPort,
    private readonly logger: LoggerPort
  ) {}

  async execute(input: RefineSingleTicketInput): Promise<Result<RefineSingleTicketOutput, DomainError>> {
    if (input.ticket.requirementStatus !== 'pending') {
      return Result.error(
        new InvalidStateError({
          entity: 'ticket',
          currentState: input.ticket.requirementStatus,
          attemptedAction: 'refine',
        })
      );
    }

    const log = this.logger.child({
      sprintId: input.sprint.id,
      ticketId: input.ticket.id,
    });

    const promptResult = await this.prompts.buildRefinePrompt({ ticket: input.ticket });
    if (!promptResult.ok) return Result.error(promptResult.error);

    log.info('refining ticket', { title: input.ticket.title });
    const sessionResult = await this.ai.spawnHeadless(promptResult.value, {
      cwd: input.cwd,
      ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
    });
    if (!sessionResult.ok) return Result.error(sessionResult.error);

    const requirementsText = extractRequirements(sessionResult.value.output);
    const approved = input.ticket.approveRequirements(requirementsText);
    if (!approved.ok) return Result.error(approved.error);

    return Result.ok({
      ticket: approved.value,
      rawAiOutput: sessionResult.value.output,
    });
  }
}

// TODO: Replace the loose preamble-stripping heuristic below with a
// structured parser (XML/JSON envelope) once the prompt template emits
// one. Today it preserves the legacy behaviour: take the AI's raw text as
// the requirements body and trim away conversational boilerplate.
const PREAMBLE_REGEX = /^\s*(here\s+is|here\s+are|below\s+is|below\s+are)\b[^\n]*\n+/i;

function extractRequirements(output: string): string {
  const trimmed = output.trim();
  return trimmed.replace(PREAMBLE_REGEX, '').trim();
}
