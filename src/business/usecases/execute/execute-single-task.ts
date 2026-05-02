/**
 * `ExecuteSingleTaskUseCase` — drive ONE task end-to-end via the AI session
 * and return its outcome plus every parsed signal (in emission order).
 *
 * Single-responsibility: build the prompt, spawn (or resume) the AI,
 * parse signals, classify the outcome. Persistence (status updates, sidecar
 * writes) and orchestration (rate-limit pause/resume, retries, parallel
 * scheduling) are chain-layer concerns and live elsewhere.
 *
 * Outcome classification rules:
 *  - `task-blocked` signal present → `'blocked'`.
 *  - Spawn failure carrying a rate-limit hint → `'rate-limited'` (the chain
 *    is responsible for global pause/resume + resuming via `resumeSessionId`).
 *  - Spawn failure with any other cause → `'failed'`.
 *  - `task-complete` signal present → `'completed'`.
 *  - Otherwise → `'failed'` (no completion signal, no specific blocker).
 *
 * Rate-limit detection: the underlying `AiSessionPort` returns
 * `Result<SessionResult, DomainError>` — there's no dedicated `SpawnError`
 * brand in `src` yet (the legacy `SpawnError.rateLimited` flag is
 * gone). Until a richer error vocabulary lands, this use case classifies
 * a spawn `StorageError` as rate-limited iff its message matches the same
 * pattern set the legacy `detectSpawnRateLimit` used: `rate.?limit`,
 * `\b429\b`, `too many requests`, `overloaded`, `\b529\b`.
 *
 * TODO: introduce a typed `SpawnError` (or `StorageError` subCode) in the
 * domain layer so this string-matching heuristic becomes a structural check.
 */
import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Task } from '@src/domain/entities/task.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import { Result } from '@src/domain/result.ts';
import type { HarnessSignal } from '@src/domain/signals/harness-signal.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import type { AiSessionPort } from '@src/business/ports/ai-session-port.ts';
import type { LoggerPort } from '@src/business/ports/logger-port.ts';
import type { PromptBuilderPort } from '@src/business/ports/prompt-builder-port.ts';
import type { SignalBusPort } from '@src/business/ports/signal-bus-port.ts';
import type { SignalParserPort } from '@src/business/ports/signal-parser-port.ts';
import type { RateLimitCoordinator } from '@src/kernel/algorithms/rate-limit-coordinator.ts';

/** Possible outcomes of a single-task execution attempt. */
export type TaskExecutionOutcome = 'completed' | 'blocked' | 'rate-limited' | 'failed';

export interface ExecuteSingleTaskInput {
  readonly task: Task;
  readonly sprint: Sprint;
  /** Working directory for the AI session — typically `task.projectPath`. */
  readonly cwd: AbsolutePath;
  /** Provider session id to resume on rate-limit recovery. */
  readonly resumeSessionId?: string;
  /** Optional cooperative cancellation. */
  readonly abortSignal?: AbortSignal;
}

export interface ExecuteSingleTaskOutput {
  readonly outcome: TaskExecutionOutcome;
  /** Every harness signal parsed from the AI output, in emission order. */
  readonly signals: readonly HarnessSignal[];
  /** Provider-assigned session id, when surfaced — used to resume next round. */
  readonly newSessionId?: string;
  /** Set on `'rate-limited'` outcomes so the chain can timestamp the pause. */
  readonly rateLimitedAt?: IsoTimestamp;
  /** Reason text for `'blocked'` / `'failed'` outcomes (best-effort, may be empty). */
  readonly reason?: string;
}

const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /rate.?limit/i,
  /\b429\b/,
  /too many requests/i,
  /overloaded/i,
  /\b529\b/,
];

function looksRateLimited(err: DomainError): boolean {
  if (err.code !== 'storage-error') return false;
  return RATE_LIMIT_PATTERNS.some((p) => p.test(err.message));
}

export class ExecuteSingleTaskUseCase {
  constructor(
    private readonly ai: AiSessionPort,
    private readonly prompts: PromptBuilderPort,
    private readonly parser: SignalParserPort,
    private readonly logger: LoggerPort,
    /**
     * Optional. When provided, every parsed harness signal is emitted on
     * the bus as `{ type: 'signal', signal, sprintId, taskId }` so live
     * dashboards see `<progress>`, `<note>`, `<task-verified>`, etc. in
     * real time. The bus auto-tags emissions with the current chain's
     * `sessionId` via ALS — no manual session plumbing needed.
     */
    private readonly signalBus?: SignalBusPort,
    /**
     * Optional. When provided and the spawn returns a rate-limit hint,
     * the use case calls `coordinator.pause(reason, resumeAt)` so other
     * in-flight per-task chains gate at the `wait-for-rate-limit` leaf
     * before launching their own AI sessions. Caller (chain) is
     * responsible for `coordinator.resume()` after the retry budget
     * settles.
     */
    private readonly rateLimitCoordinator?: RateLimitCoordinator
  ) {}

  async execute(input: ExecuteSingleTaskInput): Promise<Result<ExecuteSingleTaskOutput, DomainError>> {
    const log = this.logger.child({
      sprintId: input.sprint.id,
      taskId: input.task.id,
      projectPath: input.cwd,
    });

    const promptResult = await this.prompts.buildExecutePrompt({
      task: input.task,
      sprint: input.sprint,
    });
    if (!promptResult.ok) return Result.error(promptResult.error);

    log.info(`executing task ${String(input.task.id)}${formatNameSuffix(input.task.name)}`);

    const sessionOptions = {
      cwd: input.cwd,
      ...(input.resumeSessionId !== undefined ? { resumeSessionId: input.resumeSessionId } : {}),
      ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
    };

    const sessionResult =
      input.resumeSessionId !== undefined
        ? await this.ai.resumeSession(input.resumeSessionId, promptResult.value, sessionOptions)
        : await this.ai.spawnHeadless(promptResult.value, sessionOptions);

    if (!sessionResult.ok) {
      if (looksRateLimited(sessionResult.error)) {
        log.warn('rate-limited spawn', { message: sessionResult.error.message });
        // Pause the global coordinator so other in-flight per-task chains
        // gate at the `wait-for-rate-limit` leaf before launching their
        // own AI sessions. The chain's Retry on `code: 'rate-limited'`
        // owns the resume side once the kernel-level retry settles.
        this.rateLimitCoordinator?.pause(sessionResult.error.message);
        return Result.ok({
          outcome: 'rate-limited',
          signals: [],
          rateLimitedAt: IsoTimestamp.now(),
          reason: sessionResult.error.message,
        });
      }
      return Result.error(sessionResult.error);
    }

    const signals = this.parser.parse(sessionResult.value.output, { now: IsoTimestamp.now() });

    // Live observability: forward every parsed signal to the bus so the
    // execute view's "Recent events" panel renders `<progress>`, `<note>`,
    // `<task-verified>`, etc. in real time. The bus auto-tags emissions
    // with the active chain's `sessionId` via ALS so per-session views
    // can filter cleanly. Skipped when no bus is wired (CLI one-shots,
    // test fakes that opt out).
    if (this.signalBus !== undefined) {
      for (const signal of signals) {
        this.signalBus.emit({
          type: 'signal',
          signal,
          sprintId: input.sprint.id,
          taskId: input.task.id,
        });
      }
    }

    const blocked = signals.find((s) => s.type === 'task-blocked');
    if (blocked) {
      log.warn('task blocked', { reason: blocked.reason });
      return Result.ok({
        outcome: 'blocked',
        signals,
        ...(sessionResult.value.sessionId !== undefined ? { newSessionId: sessionResult.value.sessionId } : {}),
        reason: blocked.reason,
      });
    }

    const completed = signals.some((s) => s.type === 'task-complete');
    const outcome: TaskExecutionOutcome = completed ? 'completed' : 'failed';

    return Result.ok({
      outcome,
      signals,
      ...(sessionResult.value.sessionId !== undefined ? { newSessionId: sessionResult.value.sessionId } : {}),
      ...(completed ? {} : { reason: 'task did not signal completion' }),
    });
  }
}

/**
 * Render a task name slice for log messages — three parallel tasks all
 * logging "executing task" is unreadable; "executing task <id> — \"<name>\""
 * is. Mirrors `formatTitleSuffix` in refine-single-ticket.ts. Empty /
 * whitespace-only names return an empty string so the caller can concatenate
 * without leaving a dangling ` — ""`. Long names clip to 50 chars + ellipsis.
 */
function formatNameSuffix(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return '';
  const max = 50;
  const slice = trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
  return ` — "${slice}"`;
}
