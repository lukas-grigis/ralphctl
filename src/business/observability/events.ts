import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { AiSignal } from '@src/domain/signal.ts';
import type { PlateauSource } from '@src/domain/entity/attempt.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';
import type { BlockedTask } from '@src/domain/entity/task.ts';

/** Application-wide structured events. */

export interface ChainStartedEvent {
  readonly type: 'chain-started';
  readonly chainId: string;
  readonly flowId: string;
  readonly at: IsoTimestamp;
}

export interface ChainStepStartedEvent {
  readonly type: 'chain-step-started';
  readonly chainId: string;
  readonly elementName: string;
  readonly at: IsoTimestamp;
}

export interface ChainStepCompletedEvent {
  readonly type: 'chain-step-completed';
  readonly chainId: string;
  readonly elementName: string;
  readonly durationMs: number;
  readonly at: IsoTimestamp;
}

export interface ChainStepFailedEvent {
  readonly type: 'chain-step-failed';
  readonly chainId: string;
  readonly elementName: string;
  readonly error: DomainError;
  readonly durationMs: number;
  readonly at: IsoTimestamp;
}

export interface ChainCompletedEvent {
  readonly type: 'chain-completed';
  readonly chainId: string;
  readonly at: IsoTimestamp;
}

export interface ChainFailedEvent {
  readonly type: 'chain-failed';
  readonly chainId: string;
  readonly error: DomainError;
  readonly at: IsoTimestamp;
}

export interface ChainAbortedEvent {
  readonly type: 'chain-aborted';
  readonly chainId: string;
  readonly reason?: string;
  readonly at: IsoTimestamp;
}

export interface TaskAttemptStartedEvent {
  readonly type: 'task-attempt-started';
  readonly taskId: string;
  readonly sessionId: string;
  readonly at: IsoTimestamp;
}

export interface TaskAttemptEvaluatedEvent {
  readonly type: 'task-attempt-evaluated';
  readonly taskId: string;
  readonly verdict: 'passed' | 'failed' | 'malformed';
  readonly at: IsoTimestamp;
}

/**
 * Fired once at the start of every gen-eval round for the in-flight task — the discrete boundary the chain trace
 * lacks (back-to-back `generator-<id>` / `evaluator-<id>` entries carry no round number).
 */
export interface TaskRoundStartedEvent {
  readonly type: 'task-round-started';
  readonly taskId: string;
  readonly attemptN: number;
  readonly roundN: number;
  readonly totalCap: number;
  readonly at: IsoTimestamp;
}

export interface FeedbackRoundAppliedEvent {
  readonly type: 'feedback-round-applied';
  readonly sprintId: string;
  readonly round: number;
  readonly at: IsoTimestamp;
}

/** A flow is blocked on an operator answer (prompt enqueued). `sessionId` is the owning run, when known. */
export interface AwaitingInputEvent {
  readonly type: 'awaiting-input';
  readonly message: string;
  readonly sessionId?: string;
  readonly at: IsoTimestamp;
}

export interface LogEvent {
  readonly type: 'log';
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly at: IsoTimestamp;
}

/** Process-wide heap-pressure signal. */
export interface MemoryPressureEvent {
  readonly type: 'memory-pressure';
  readonly severity: 'warning' | 'critical' | 'recovered';
  /** heapUsed / heap_size_limit ratio at sample time, 0–1. */
  readonly ratio: number;
  /** Bytes used. */
  readonly heapUsed: number;
  /** V8's `heap_size_limit`. */
  readonly heapLimit: number;
  readonly at: IsoTimestamp;
}

/** The TUI latches a banner from this event and only clears it when the TUI restarts. */
export interface ChainLogDegradedEvent {
  readonly type: 'chain-log-degraded';
  readonly reason: 'queue-full' | 'write-failed';
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly at: IsoTimestamp;
}

/**
 * Final token-usage figure for one provider spawn, emitted ONCE per spawn after the AI session finishes cleanly
 * (non-zero exit / abort → no event).
 */
export interface TokenUsageEvent {
  readonly type: 'token-usage';
  /**
   * The AI CLI's own session uuid for this spawn (Claude `system.init` id, Copilot `sessionId`, Codex `thread_id`).
   */
  readonly sessionId: string;
  /**
   * The chain runner / session id this spawn ran under, read from `rootSessionId()` (the runner wraps every
   * `element.execute()` in `runWithSession(id, …)`.
   */
  readonly chainSessionId?: string;
  readonly provider: AiProvider;
  readonly model?: string;
  /** CUMULATIVE token counts for the whole spawn — these are throughput / billing figures. */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  /** LIVE per-turn token counts — a single-call snapshot from the LAST assistant turn of the spawn. */
  readonly liveInputTokens?: number;
  readonly liveCacheReadTokens?: number;
  readonly liveCacheCreationTokens?: number;
  readonly contextWindow?: number;
  /** Implement-flow gen-eval role the spawn ran under. */
  readonly role?: 'generator' | 'evaluator';
  readonly at: IsoTimestamp;
}

/**
 * Tiered status banner — generic surface for "operator should know this is happening" signals that don't deserve
 * their own bespoke banner component.
 */
export interface BannerShowEvent {
  readonly type: 'banner-show';
  /** Stable key — re-publishing replaces; clears match on id. */
  readonly id: string;
  readonly tier: 'info' | 'warn' | 'error';
  readonly message: string;
  /** Optional supplementary detail rendered dim beside the message. */
  readonly cause?: string;
  readonly at: IsoTimestamp;
}

export interface BannerClearEvent {
  readonly type: 'banner-clear';
  readonly id: string;
  readonly at: IsoTimestamp;
}

/**
 * Discriminated union of the two banner events — exported as a type alias so emitters can type-narrow a single
 * subscription handler over both variants without restating the union.
 * @public
 */
export type BannerEvent = BannerShowEvent | BannerClearEvent;

/**
 * Validated `AiSignal` published by an AI-spawning leaf AFTER the spawn's `signals.json` was parsed by
 * `validateSignalsFile` under the audit-[09] contract.
 */
export interface AiSignalEvent {
  readonly type: 'ai-signal';
  readonly signal: AiSignal;
  readonly source: string;
  readonly taskId?: string;
}

/** Once-per-task generator model escalation fired. */
export interface ModelEscalatedEvent {
  readonly type: 'model-escalated';
  readonly taskId: string;
  readonly attemptN: number;
  readonly from: string;
  readonly to: string;
  readonly reason: 'plateau' | 'budget-exhausted';
  readonly plateauSource?: PlateauSource;
  readonly at: IsoTimestamp;
}

/**
 * Fired once when `settleAttemptUseCase` (`business/task/settle-attempt.ts`) settles a task into `blocked`.
 */
export interface TaskBlockedEvent {
  readonly type: 'task-blocked';
  readonly taskId: string;
  readonly taskName: string;
  readonly blockKind: BlockedTask['blockKind'];
  readonly reason: string;
  readonly at: IsoTimestamp;
}

export type AppEvent =
  | ChainStartedEvent
  | ChainStepStartedEvent
  | ChainStepCompletedEvent
  | ChainStepFailedEvent
  | ChainCompletedEvent
  | ChainFailedEvent
  | ChainAbortedEvent
  | TaskAttemptStartedEvent
  | TaskAttemptEvaluatedEvent
  | TaskRoundStartedEvent
  | FeedbackRoundAppliedEvent
  | AwaitingInputEvent
  | LogEvent
  | MemoryPressureEvent
  | ChainLogDegradedEvent
  | TokenUsageEvent
  | BannerShowEvent
  | BannerClearEvent
  | AiSignalEvent
  | ModelEscalatedEvent
  | TaskBlockedEvent;
