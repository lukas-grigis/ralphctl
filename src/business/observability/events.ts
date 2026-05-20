import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

/**
 * Application-wide structured events. Producers (chain runner, use cases,
 * adapters) publish these via {@link EventBus}; subscribers (TUI panels,
 * progress files, future webhooks) read them without knowing who fired them.
 *
 * Each variant is a named interface so subscribers can take the variant
 * directly (`(e: LogEvent) => void`) instead of narrowing the whole union.
 * The discriminated `type` field is the only field guaranteed across variants;
 * each variant carries its own correlation handles (`chainId`, `taskId`,
 * `sprintId`, …) so a subscriber can filter by topic without parsing strings.
 *
 * `LogEvent` is included so the existing log-emit producers fold into the bus —
 * one subscriber taps both progress milestones and free-form messages without
 * two ports.
 */

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
 * Fired once at the start of every gen-eval round for the in-flight task — the discrete
 * boundary the chain trace lacks (back-to-back `generator-<id>` / `evaluator-<id>` entries
 * carry no round number). Replaces the TUI's ref-based round-counter high-water mark with an
 * authoritative source: the latest event's `roundN` is the round currently running.
 *
 *  - `roundN` is 1-indexed and matches the on-disk `rounds/<N>/` folder index used by the
 *    generator + evaluator leaves.
 *  - `totalCap` is the configured `settings.harness.maxTurns`, surfaced so subscribers can
 *    render `round N/M` without a second config lookup.
 *  - `attemptN` is the 1-indexed attempt-within-task counter — multiple attempts are gated by
 *    `task.maxAttempts`; emitted here so the recent-log tail can disambiguate "round 2 of
 *    attempt 1" vs. "round 1 of attempt 2".
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

export interface LogEvent {
  readonly type: 'log';
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly at: IsoTimestamp;
}

/**
 * Process-wide heap-pressure signal. Emitted by the heap watchdog on every
 * threshold TRANSITION (not on every poll) so subscribers can render a banner
 * that mirrors the current band without de-duping a stream of identical samples.
 *
 * `'recovered'` is fired once when the ratio drops back below the warning band,
 * giving the banner an explicit clear signal.
 */
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

/**
 * Signals that the persistent `<sprintDir>/chain.log` sink can no longer keep up with the
 * event-bus firehose — either because its in-memory queue hit the back-pressure cap
 * (`reason: 'queue-full'`) or because an actual `fs.appendFile` write rejected
 * (`reason: 'write-failed'`). Emitted EXACTLY ONCE per sink lifetime: once the first
 * degradation fires the sink stops re-emitting, because the contract is "tell the operator
 * the log is no longer trustworthy", not "spam the bus every time a write fails". The TUI
 * latches a banner from this event and only clears it when the TUI restarts.
 */
export interface ChainLogDegradedEvent {
  readonly type: 'chain-log-degraded';
  readonly reason: 'queue-full' | 'write-failed';
  readonly meta?: Readonly<Record<string, unknown>>;
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
  | LogEvent
  | MemoryPressureEvent
  | ChainLogDegradedEvent;
