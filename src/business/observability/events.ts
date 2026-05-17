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
  | FeedbackRoundAppliedEvent
  | LogEvent;
