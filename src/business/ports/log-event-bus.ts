/**
 * Port for the UI-facing log event stream.
 *
 * The logger sink publishes structured events on a `LogEventBus`; UI adapters
 * subscribe to render a rolling log tail. Kept as a port (not an integration
 * detail) so the execution registry can expose per-execution buses on its own
 * port without integration types leaking into business.
 *
 * The concrete in-memory adapter lives in
 * `src/integration/ui/tui/runtime/event-bus.ts` alongside the default singleton.
 *
 * Semantically different from `SignalBusPort` — signals are typed domain events
 * from the AI harness, log events are free-form UI output (levelled log lines,
 * spinners, headers, cards) emitted by `LoggerPort` implementations.
 */

import type { LogContext } from './logger.ts';

export type LogEventLevel = 'debug' | 'info' | 'warn' | 'error' | 'success' | 'warning' | 'tip' | 'item' | 'dim';

export type LogEvent =
  | { kind: 'log'; level: LogEventLevel; message: string; context: LogContext; timestamp: Date }
  | { kind: 'header'; title: string; icon?: string; timestamp: Date }
  | { kind: 'separator'; width: number; timestamp: Date }
  | { kind: 'field'; label: string; value: string; timestamp: Date }
  | { kind: 'card'; title: string; lines: string[]; timestamp: Date }
  | { kind: 'newline'; timestamp: Date }
  | { kind: 'spinner-start'; id: number; message: string; timestamp: Date }
  | { kind: 'spinner-succeed'; id: number; message: string; timestamp: Date }
  | { kind: 'spinner-fail'; id: number; message: string; timestamp: Date }
  | { kind: 'spinner-stop'; id: number; timestamp: Date };

export type LogEventListener = (events: readonly LogEvent[]) => void;
export type LogEventUnsubscribe = () => void;

export interface LogEventBus {
  emit(event: LogEvent): void;
  subscribe(listener: LogEventListener): LogEventUnsubscribe;
  dispose(): void;
}
