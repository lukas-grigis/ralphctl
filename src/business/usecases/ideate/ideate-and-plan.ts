/**
 * `IdeateAndPlanUseCase` — quick-path workflow that combines refinement
 * and planning in a single AI session: the user provides a free-text idea
 * + project, the AI emits a `<ticket>` block (title + description +
 * requirements) AND a `<tasks>` JSON list. We return a newly-constructed,
 * already-approved `Ticket` plus the parsed `Task[]`.
 *
 * The full ideate prompt is written to disk by the upstream
 * `render-prompt-to-file` chain leaf. This use case receives the path
 * and hands the AI a thin wrapper via {@link renderFileHandoffWrapper}.
 *
 * Saving the ticket onto the sprint and the tasks onto the task store is
 * a chain-layer concern.
 */
import type { Project } from '@src/domain/entities/project.ts';
import type { Sprint } from '@src/domain/entities/sprint.ts';
import { Task } from '@src/domain/entities/task.ts';
import { Ticket } from '@src/domain/entities/ticket.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import { InvalidStateError } from '@src/domain/errors/invalid-state-error.ts';
import { ParseError } from '@src/domain/errors/parse-error.ts';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { ValidationError } from '@src/domain/values/validation-error.ts';
import type { AiSessionPort } from '@src/business/ports/ai-session-port.ts';
import type { LoggerPort } from '@src/business/ports/logger-port.ts';
import { renderFileHandoffWrapper } from '@src/business/usecases/_shared/file-handoff-wrapper.ts';
import { buildTasksFromEntries } from '@src/business/usecases/plan/task-list-parser.ts';

/** Inputs to {@link IdeateAndPlanUseCase}. */
export interface IdeateAndPlanInput {
  /** Loaded sprint — must be `draft`; may have zero tickets. */
  readonly sprint: Sprint;
  /** Free-form idea text supplied by the user. */
  readonly ideaText: string;
  /** Pre-selected project — drives `projectName` on the new ticket. */
  readonly project: Project;
  /** Working directory for the AI session. */
  readonly cwd: AbsolutePath;
  /**
   * Absolute path to the ideate prompt file produced by the upstream
   * `render-prompt-to-file` leaf. Required — the wrapper the AI
   * receives points at this path.
   */
  readonly promptFilePath: string;
  /**
   * Optional absolute path the AI session adapter writes a `session.md`
   * audit record to. Best-effort.
   */
  readonly sessionMdPath?: AbsolutePath;
  /** Optional cooperative cancellation. */
  readonly abortSignal?: AbortSignal;
}

/** Outputs from {@link IdeateAndPlanUseCase}. */
export interface IdeateAndPlanOutput {
  /** Newly-constructed and already-approved ticket. */
  readonly ticket: Ticket;
  /** Tasks generated for the new ticket — `ticketId` set to the new id. */
  readonly tasks: readonly Task[];
  /** Raw AI stdout — kept for diagnostics. */
  readonly rawAiOutput: string;
}

/** Maximum length of the synthesized ticket title when AI omits its own. */
const TITLE_FALLBACK_MAX = 80;

const TICKET_BLOCK_REGEX = /<ticket\b[^>]*>([\s\S]*?)<\/ticket>/i;
const TASKS_BLOCK_REGEX = /<tasks\b[^>]*>([\s\S]*?)<\/tasks>/i;
const TITLE_REGEX = /<title\b[^>]*>([\s\S]*?)<\/title>/i;
const DESCRIPTION_REGEX = /<description\b[^>]*>([\s\S]*?)<\/description>/i;
const REQUIREMENTS_REGEX = /<requirements\b[^>]*>([\s\S]*?)<\/requirements>/i;

export class IdeateAndPlanUseCase {
  constructor(
    private readonly ai: AiSessionPort,
    private readonly logger: LoggerPort
  ) {}

  async execute(input: IdeateAndPlanInput): Promise<Result<IdeateAndPlanOutput, DomainError>> {
    if (input.sprint.status !== 'draft') {
      return Result.error(
        new InvalidStateError({
          entity: 'sprint',
          currentState: input.sprint.status,
          attemptedAction: 'ideate',
        })
      );
    }

    const log = this.logger.child({ sprintId: input.sprint.id });

    // The full prompt is on disk at `input.promptFilePath`. Hand the AI
    // a thin wrapper pointing at it.
    const wrapper = renderFileHandoffWrapper(input.promptFilePath);

    log.info('ideating', { project: input.project.name });

    const sessionResult = await this.ai.spawnHeadless(wrapper, {
      cwd: input.cwd,
      ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
      ...(input.sessionMdPath !== undefined ? { sessionMdPath: input.sessionMdPath } : {}),
    });
    if (!sessionResult.ok) return Result.error(sessionResult.error);

    const output = sessionResult.value.output;
    const parsedTasks = parseTasksFromOutput(output);
    if (!parsedTasks.ok) return Result.error(parsedTasks.error);

    // Guard 1: projectPath must be one of the project's repositories. The
    // ideate flow doesn't yet have `sprint.affectedRepositories` set (that
    // is populated by `persist-repo-selection` in the plan flow only), so
    // we fall back to the project's repositories. Same intent: catch AI
    // hallucinations early instead of blowing up at session-spawn time.
    const validRepoPaths = new Set(input.project.repositories.map((r) => String(r.path)));
    for (const [i, task] of parsedTasks.value.entries()) {
      const path = String(task.projectPath);
      if (!validRepoPaths.has(path)) {
        return Result.error(
          new ParseError({
            subCode: 'schema-mismatch',
            message: `task[${String(i)}] projectPath '${path}' is not one of the project's repositories. Allowed: ${[...validRepoPaths].join(', ')}`,
          })
        );
      }
    }

    // Guard 3: empty task list — AI ran the prompt and gave up. Surface
    // here rather than letting it fall through to a no-op chain run.
    if (parsedTasks.value.length === 0) {
      return Result.error(
        new ParseError({
          subCode: 'schema-mismatch',
          message: 'AI emitted an empty task list. The model produced JSON `[]`. Inspect the session log; rerun.',
        })
      );
    }

    const ticketParts = extractTicketParts(output, input.ideaText);

    const ticketResult = Ticket.create({
      title: ticketParts.title,
      ...(ticketParts.description !== undefined ? { description: ticketParts.description } : {}),
    });
    if (!ticketResult.ok) return Result.error(ticketResult.error);

    const approved = ticketResult.value.approveRequirements(ticketParts.requirements);
    if (!approved.ok) return Result.error(approved.error);

    // Guard 2: ticketId — for ideate the new ticket is the only valid one,
    // so any explicit AI-emitted ticketId that doesn't match is a typo.
    // Run AFTER the new ticket is created (we need its id) and BEFORE
    // assignTicketId fills the blanks.
    const newTicketId = String(approved.value.id);
    for (const [i, task] of parsedTasks.value.entries()) {
      if (task.ticketId !== undefined && String(task.ticketId) !== newTicketId) {
        return Result.error(
          new ParseError({
            subCode: 'schema-mismatch',
            message: `task[${String(i)}] ticketId '${String(task.ticketId)}' does not match the ideated ticket. Allowed: ${newTicketId}`,
          })
        );
      }
    }

    // Auto-assign the new ticket id to every task that doesn't already
    // declare one. Tasks emitted with explicit ticketIds are honoured.
    const tasksWithTicket = parsedTasks.value.map((t) =>
      t.ticketId === undefined ? assignTicketId(t, approved.value) : t
    );

    return Result.ok({
      ticket: approved.value,
      tasks: tasksWithTicket,
      rawAiOutput: output,
    });
  }
}

// ───────────────────────── parsers ─────────────────────────

interface TicketParts {
  readonly title: string;
  readonly description: string | undefined;
  readonly requirements: string;
}

function extractTicketParts(rawOutput: string, fallbackIdeaText: string): TicketParts {
  const ticketMatch = TICKET_BLOCK_REGEX.exec(rawOutput);
  if (!ticketMatch?.[1]) {
    // Bare-tasks-array case: requirements treated as empty, title falls
    // back to (truncated) idea text. Mirrors legacy behaviour.
    return {
      title: truncate(fallbackIdeaText.trim(), TITLE_FALLBACK_MAX) || 'idea',
      description: undefined,
      requirements: '',
    };
  }

  const body = ticketMatch[1];
  const titleMatch = TITLE_REGEX.exec(body);
  const descriptionMatch = DESCRIPTION_REGEX.exec(body);
  const requirementsMatch = REQUIREMENTS_REGEX.exec(body);

  const title = titleMatch?.[1] ? titleMatch[1].trim() : truncate(fallbackIdeaText.trim(), TITLE_FALLBACK_MAX);
  const description = descriptionMatch?.[1] ? descriptionMatch[1].trim() : undefined;
  const requirements = requirementsMatch?.[1] ? requirementsMatch[1].trim() : '';

  return {
    title: title.length > 0 ? title : 'idea',
    description: description !== undefined && description.length > 0 ? description : undefined,
    requirements,
  };
}

function parseTasksFromOutput(rawOutput: string): Result<readonly Task[], ParseError | ValidationError> {
  const tasksMatch = TASKS_BLOCK_REGEX.exec(rawOutput);
  const jsonText = tasksMatch?.[1] ? tasksMatch[1].trim() : extractBareArray(rawOutput);
  if (jsonText === null) {
    return Result.error(
      new ParseError({
        subCode: 'invalid-json',
        message: 'no <tasks> block or JSON array found in AI output',
      })
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (cause) {
    return Result.error(
      new ParseError({
        subCode: 'invalid-json',
        message: 'tasks JSON could not be parsed',
        cause,
      })
    );
  }

  if (!Array.isArray(parsed)) {
    return Result.error(
      new ParseError({
        subCode: 'schema-mismatch',
        message: 'tasks block must contain a JSON array',
      })
    );
  }
  return buildTasksFromEntries(parsed);
}

function extractBareArray(rawOutput: string): string | null {
  const start = rawOutput.indexOf('[');
  const end = rawOutput.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  return rawOutput.slice(start, end + 1);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

function assignTicketId(task: Task, ticket: Ticket): Task {
  // `Task.create` is the only path that builds a fresh entity; since we
  // can't mutate, build a replacement task with the same fields plus the
  // new ticketId. Failure here would be a ValidationError, but every
  // input came from a valid Task already.
  const replacement = Task.create({
    id: task.id,
    name: task.name,
    ...(task.description !== undefined ? { description: task.description } : {}),
    steps: task.steps,
    verificationCriteria: task.verificationCriteria,
    order: task.order,
    ticketId: ticket.id,
    blockedBy: task.blockedBy,
    projectPath: task.projectPath,
    ...(task.extraDimensions !== undefined ? { extraDimensions: task.extraDimensions } : {}),
  });
  return replacement.ok ? replacement.value : task;
}
