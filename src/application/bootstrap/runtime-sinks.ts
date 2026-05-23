import type { HarnessSignalSink } from '@src/business/observability/harness-signal-sink.ts';

/**
 * Output sinks the composition root threads through `wire()`. After the LogSink → EventBus
 * migration this is harness-only — log entries flow through `AppDeps.eventBus` as
 * `'log'` AppEvents, and TUI panels / file appenders subscribe to the bus directly. The
 * harness signal sink stays separate because harness signals are structured AI output
 * (`<learning>`, `<task-complete>`, …) parsed at the AI/harness boundary, not application
 * observability.
 */
export interface AppSinks {
  /** Structured AI session signals (progress, evaluation, task verdicts, …). */
  readonly harness: HarnessSignalSink;
}
