/**
 * Process-wide log event bus singleton for the Ink TUI.
 *
 * The Ink-mounted app subscribes via `useLoggerEvents()` and renders a
 * rolling log tail. Outside of Ink (plain CLI commands), the default
 * singleton is never subscribed to and its emissions are harmlessly dropped.
 *
 * The `InMemoryLogEventBus` is already in integration/logging — we re-use
 * it here rather than duplicating. This module just owns the singleton.
 *
 */

import { InMemoryLogEventBus } from '@src/integration/logging/log-event-bus.ts';

export type { LogEvent, LogEventBus } from '@src/integration/logging/log-event-bus.ts';

/**
 * Process-wide singleton log event bus.
 *
 * The `InkSink` logger publishes to this bus. The dashboard `<LogTail />`
 * subscribes from this bus. Multiple subscription-less environments (plain
 * CLI) never attach a subscriber, so events are cheaply dropped.
 */
export const logEventBus: InMemoryLogEventBus = new InMemoryLogEventBus();
