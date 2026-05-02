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
 * Single-responsibility on purpose. Saving the new tasks, cleaning up
 * abandoned ones, and re-ordering by dependencies are chain-layer
 * concerns — this class only owns the AI round-trip + parse. The parser
 * lives in {@link ./task-list-parser.ts} so this file stays focused on
 * orchestration.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Task } from '@src/domain/entities/task.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import { InvalidStateError } from '@src/domain/errors/invalid-state-error.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { AiSessionPort } from '@src/business/ports/ai-session-port.ts';
import type { LoggerPort } from '@src/business/ports/logger-port.ts';
import type { PromptBuilderPort } from '@src/business/ports/prompt-builder-port.ts';
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

    const promptResult = await this.prompts.buildPlanPrompt({
      sprint: input.sprint,
      existingTasks: input.existingTasks,
      ...(interactive && input.outputFilePath !== undefined ? { outputFilePath: input.outputFilePath } : {}),
    });
    if (!promptResult.ok) return Result.error(promptResult.error);

    log.info(`planning tasks for sprint ${String(input.sprint.id)}`, {
      tickets: input.sprint.tickets.length,
      replan: input.existingTasks.length > 0,
      mode: interactive ? 'interactive' : 'headless',
    });

    if (interactive) {
      return this.runInteractive(input, promptResult.value, log);
    }

    const extraArgs = buildAdditionalCwdArgs(input.additionalRepoPaths);
    const sessionResult = await this.ai.spawnHeadless(promptResult.value, {
      cwd: input.cwd,
      ...(extraArgs.length > 0 ? { args: extraArgs } : {}),
      ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
    });
    if (!sessionResult.ok) return Result.error(sessionResult.error);

    const parsed = parseTaskList(sessionResult.value.output);
    if (!parsed.ok) return Result.error(parsed.error);

    log.success(`planned ${String(parsed.value.length)} tasks for sprint ${String(input.sprint.id)}`);
    return Result.ok({
      tasks: parsed.value,
      rawAiOutput: sessionResult.value.output,
    });
  }

  // The full prompt is stashed in `planning-context.md` next to the
  // output file; Claude is bootstrapped with a one-liner pointing at
  // it so the chat history doesn't fill with the whole spec before the
  // user sees any response.
  private async runInteractive(
    input: PlanSprintTasksInput,
    prompt: string,
    log: ReturnType<LoggerPort['child']>
  ): Promise<Result<PlanSprintTasksOutput, DomainError>> {
    const handover = input.runInTerminal ?? (async <T>(fn: () => Promise<T>): Promise<T> => fn());

    const outputPath = input.outputFilePath ?? '';
    const contextDir = dirname(outputPath);
    const contextPath = `${contextDir}/planning-context.md`;
    try {
      await mkdir(contextDir, { recursive: true });
      await writeFile(contextPath, prompt, 'utf-8');
    } catch (err) {
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: `interactive plan: failed to write context file at ${contextPath}: ${err instanceof Error ? err.message : String(err)}`,
          path: contextPath,
          cause: err,
        })
      );
    }

    // `--add-dir` roots: the planning context dir (so Claude can read
    // the handoff file and write tasks.json under acceptEdits without
    // prompting), plus every repo the user picked at launch (so
    // exploration reads land in pre-allowed paths).
    const extraArgs = [...buildAdditionalCwdArgs(input.additionalRepoPaths), '--add-dir', contextDir];

    const bootstrap = `I need help planning tasks for sprint "${input.sprint.name}". The full context — sprint metadata, ticket requirements, repos, output schema — is in \`${contextPath}\`. Please read that file now and follow the instructions to generate the task list.`;

    const spawnResult = await handover(() =>
      this.ai.spawnInteractive(bootstrap, {
        cwd: input.cwd,
        ...(extraArgs.length > 0 ? { args: extraArgs } : {}),
        ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
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

    log.success(`planned ${String(parsed.value.length)} tasks for sprint ${String(input.sprint.id)}`);
    return Result.ok({
      tasks: parsed.value,
      rawAiOutput: raw,
    });
  }
}

/**
 * Translate a list of additional repo paths into Claude-CLI's
 * `--add-dir <path>` flag pairs. Returns `[]` when the input is empty
 * so callers can spread without injecting an empty `args` field.
 *
 * Provider-specific knob — Copilot's CLI uses inherited cwd only and
 * doesn't accept additional roots, so passing extraArgs to Copilot is
 * a no-op (the Copilot adapter filters unknown flags). Keeping the
 * flag-build inside the use case is fine for now; if a third provider
 * appears with different syntax, push this through the AI session port
 * as `additionalCwds: AbsolutePath[]` and let each adapter render.
 */
function buildAdditionalCwdArgs(paths: readonly AbsolutePath[] | undefined): readonly string[] {
  if (paths === undefined || paths.length === 0) return [];
  const args: string[] = [];
  for (const p of paths) args.push('--add-dir', String(p));
  return args;
}
