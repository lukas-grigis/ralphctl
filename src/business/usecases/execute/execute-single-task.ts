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
import type { Sprint } from '../../../domain/entities/sprint.ts';
import type { Task } from '../../../domain/entities/task.ts';
import type { DomainError } from '../../../domain/errors/domain-error.ts';
import { Result } from '../../../domain/result.ts';
import type { HarnessSignal } from '../../../domain/signals/harness-signal.ts';
import type { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import type { AiSessionPort } from '../../ports/ai-session-port.ts';
import type { LoggerPort } from '../../ports/logger-port.ts';
import type { PromptBuilderPort } from '../../ports/prompt-builder-port.ts';
import type { SignalParserPort } from '../../ports/signal-parser-port.ts';

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
    private readonly logger: LoggerPort
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

    log.info('executing task', { name: input.task.name });

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
