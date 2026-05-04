/**
 * `PlanSprintTasksUseCase` — drive an AI session that emits the task set
 * for a draft sprint and return the parsed `Task` list. Replan is built in:
 * pass `existingTasks` so the AI sees the prior set as context.
 *
 * Two modes:
 *  - **Headless** (default) — spawn Claude with `-p`, capture stdout,
 *    parse JSON from the captured text. Used in CI / non-TTY.
 *  - **Interactive** (`interactive: true`) — hand the terminal to
 *    Claude with `stdio: 'inherit'`. The user has the full Claude Code
 *    UI: ask-user-questions, repo exploration, plan iteration. Claude
 *    writes the final tasks JSON to `outputFilePath`; harness reads
 *    after exit.
 *
 * The full plan prompt is written to disk by the upstream
 * `render-prompt-to-file` chain leaf. This use case receives the path,
 * builds a thin wrapper via {@link renderFileHandoffWrapper}, and spawns.
 *
 * Single-responsibility on purpose. Saving the new tasks, cleaning up
 * abandoned ones, and re-ordering by dependencies are chain-layer
 * concerns — this class only owns the AI round-trip + parse. The parser
 * lives in {@link ./task-list-parser.ts} so this file stays focused on
 * orchestration.
 */
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Task } from '@src/domain/entities/task.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import { InvalidStateError } from '@src/domain/errors/invalid-state-error.ts';
import { ParseError } from '@src/domain/errors/parse-error.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { AiSessionPort } from '@src/business/ports/ai-session-port.ts';
import type { LoggerPort } from '@src/business/ports/logger-port.ts';
import { buildAdditionalCwdArgs } from '@src/business/usecases/_shared/add-dir-args.ts';
import { renderFileHandoffWrapper } from '@src/business/usecases/_shared/file-handoff-wrapper.ts';
import { parseTaskList } from './task-list-parser.ts';

/** Inputs to {@link PlanSprintTasksUseCase}. */
export interface PlanSprintTasksInput {
  /** Loaded sprint — must be `draft`, all tickets `approved`. */
  readonly sprint: Sprint;
  /** Tasks from a prior plan run. `[]` for an initial plan. */
  readonly existingTasks: readonly Task[];
  /** Working directory for the AI session. */
  readonly cwd: AbsolutePath;
  /**
   * Absolute path to the plan prompt file produced by the upstream
   * `render-prompt-to-file` leaf. Required — the wrapper the AI
   * receives points at this path.
   */
  readonly promptFilePath: string;
  /**
   * Optional absolute path the AI session adapter writes a `session.md`
   * audit record to. Set by the upstream `build-planning-folder` leaf
   * to `<planningFolderRoot>/session.md`. Best-effort.
   */
  readonly sessionMdPath?: AbsolutePath;
  /**
   * Extra repo paths the AI session should be able to read from. The
   * launcher picks these via a multi-select prompt and persists the
   * choice on each ticket's `affectedRepositories`. Each path becomes
   * an `--add-dir <path>` arg passed to the provider session — without
   * this Claude can't explore any repo other than `cwd`. Empty / undefined
   * = single-repo plan, no extra dirs.
   */
  readonly additionalRepoPaths?: readonly AbsolutePath[];
  /** When true, run Claude with stdio: 'inherit' and read tasks from `outputFilePath`. */
  readonly interactive?: boolean;
  /** Required when `interactive: true` — absolute path the AI writes tasks JSON to. */
  readonly outputFilePath?: string;
  /** Required when `interactive: true` — the screen-handover wrapper that pauses Ink. */
  readonly runInTerminal?: <T>(fn: () => Promise<T>) => Promise<T>;
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
    const interactive = input.interactive === true;
    if (interactive && (input.outputFilePath === undefined || input.outputFilePath === '')) {
      return Result.error(
        new InvalidStateError({
          entity: 'sprint',
          currentState: 'missing-output-path',
          attemptedAction: 'plan',
          message: 'interactive plan requires an outputFilePath so the harness can read the AI output',
        })
      );
    }

    log.info(`planning tasks for sprint ${String(input.sprint.id)}`, {
      tickets: input.sprint.tickets.length,
      replan: input.existingTasks.length > 0,
      mode: interactive ? 'interactive' : 'headless',
    });

    // The full plan prompt is on disk at `input.promptFilePath`. Hand
    // the AI a thin wrapper pointing at it.
    const wrapper = renderFileHandoffWrapper(input.promptFilePath);

    if (interactive) {
      return this.runInteractive(input, wrapper, log);
    }

    const extraArgs = buildAdditionalCwdArgs(input.additionalRepoPaths);
    const sessionResult = await this.ai.spawnHeadless(wrapper, {
      cwd: input.cwd,
      ...(extraArgs.length > 0 ? { args: extraArgs } : {}),
      ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
      ...(input.sessionMdPath !== undefined ? { sessionMdPath: input.sessionMdPath } : {}),
    });
    if (!sessionResult.ok) return Result.error(sessionResult.error);

    const parsed = parseTaskList(sessionResult.value.output);
    if (!parsed.ok) return Result.error(parsed.error);

    const guard = validateTasksAgainstSprint(parsed.value, input.sprint);
    if (!guard.ok) return Result.error(guard.error);

    log.success(`planned ${String(parsed.value.length)} tasks for sprint ${String(input.sprint.id)}`);
    return Result.ok({
      tasks: parsed.value,
      rawAiOutput: sessionResult.value.output,
    });
  }

  // The full plan prompt is at `input.promptFilePath` (already on disk
  // via the chain's `render-prompt-to-file` leaf). Claude is bootstrapped
  // with the file-handoff wrapper so the chat history doesn't fill with
  // the whole spec before the user sees any response.
  private async runInteractive(
    input: PlanSprintTasksInput,
    wrapper: string,
    log: ReturnType<LoggerPort['child']>
  ): Promise<Result<PlanSprintTasksOutput, DomainError>> {
    const handover = input.runInTerminal ?? (async <T>(fn: () => Promise<T>): Promise<T> => fn());

    // `--add-dir` roots: the prompt file's directory (so Claude can read
    // the handoff target and write tasks.json under acceptEdits without
    // prompting), plus every repo the user picked at launch (so
    // exploration reads land in pre-allowed paths).
    const promptDir = dirname(input.promptFilePath);
    const outputDir = input.outputFilePath !== undefined ? dirname(input.outputFilePath) : promptDir;
    const repoArgs = buildAdditionalCwdArgs(input.additionalRepoPaths);
    const extraArgs = [...repoArgs, '--add-dir', promptDir];
    if (outputDir !== promptDir) {
      extraArgs.push('--add-dir', outputDir);
    }

    const spawnResult = await handover(() =>
      this.ai.spawnInteractive(wrapper, {
        cwd: input.cwd,
        ...(extraArgs.length > 0 ? { args: extraArgs } : {}),
        ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
        ...(input.sessionMdPath !== undefined ? { sessionMdPath: input.sessionMdPath } : {}),
      })
    );
    if (!spawnResult.ok) return Result.error(spawnResult.error);

    const path = input.outputFilePath ?? '';
    if (path === '') {
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: 'interactive plan: outputFilePath required (validated above; should not reach this branch)',
        })
      );
    }

    let raw: string;
    try {
      raw = await readFile(path, 'utf-8');
    } catch (err) {
      log.warn(`plan output file missing for sprint ${String(input.sprint.id)}`, {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: `interactive plan: AI did not write tasks to ${path}. Re-run and ensure Claude reaches the "Write tasks JSON" step before exiting.`,
          path,
          cause: err,
        })
      );
    }

    // The parser already handles fenced ```json blocks AND a bare top-level
    // array, so feeding it the file body works for either format.
    const parsed = parseTaskList(raw);
    if (!parsed.ok) return Result.error(parsed.error);

    const guard = validateTasksAgainstSprint(parsed.value, input.sprint);
    if (!guard.ok) return Result.error(guard.error);

    log.success(`planned ${String(parsed.value.length)} tasks for sprint ${String(input.sprint.id)}`);
    return Result.ok({
      tasks: parsed.value,
      rawAiOutput: raw,
    });
  }
}

/**
 * Cross-reference parsed tasks against the sprint they belong to. The parser
 * is sprint-unaware on purpose — it only checks shape and value-object
 * validity. These checks close the gap between "JSON parsed" and "AI emitted
 * something the rest of the pipeline can use":
 *
 *  - Empty list — `[]` parses fine but means the AI ran the prompt and gave
 *    up. Surface it here so the failure is at parse time, not later in
 *    `assert-tasks-not-empty` deep inside `executeFlow`.
 *  - `projectPath` outside the sprint's affected repos — would spawn the AI
 *    in an unrelated directory or throw ENOENT mid-execute.
 *  - `ticketId` outside the sprint's tickets — would orphan the task and
 *    break refinement / progress views that key off the ticketId.
 */
function validateTasksAgainstSprint(tasks: readonly Task[], sprint: Sprint): Result<void, ParseError> {
  if (tasks.length === 0) {
    return Result.error(
      new ParseError({
        subCode: 'schema-mismatch',
        message: 'AI emitted an empty task list. The model produced JSON `[]`. Inspect the session log; rerun.',
      })
    );
  }

  const validRepoPaths = new Set(sprint.affectedRepositories.map((p) => String(p)));
  const validTicketIds = new Set(sprint.tickets.map((t) => String(t.id)));

  for (const [i, task] of tasks.entries()) {
    const path = String(task.projectPath);
    if (!validRepoPaths.has(path)) {
      return Result.error(
        new ParseError({
          subCode: 'schema-mismatch',
          message: `task[${String(i)}] projectPath '${path}' is not one of the sprint's affected repositories. Allowed: ${[...validRepoPaths].join(', ')}`,
        })
      );
    }
    if (task.ticketId !== undefined && !validTicketIds.has(String(task.ticketId))) {
      return Result.error(
        new ParseError({
          subCode: 'schema-mismatch',
          message: `task[${String(i)}] ticketId '${String(task.ticketId)}' does not match any sprint ticket. Allowed: ${[...validTicketIds].join(', ')}`,
        })
      );
    }
  }

  return Result.ok(undefined);
}
