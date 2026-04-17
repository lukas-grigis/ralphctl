import type { LoggerPort } from '@src/business/ports/logger.ts';
import { JsonLogger } from './json-logger.ts';
import { PlainTextSink } from './plain-text-sink.ts';

/**
 * Default logger factory for non-Ink contexts (one-shot CLI commands).
 * - TTY stdout → `PlainTextSink` (ANSI colored, human-readable)
 * - Non-TTY (piped, CI) → `JsonLogger` (JSON lines, machine-parseable)
 *
 * The Ink app explicitly wires `InkSink` via `createSharedDeps({ logger: new InkSink() })`.
 */
export function createLogger(): LoggerPort {
  if (process.stdout.isTTY) return new PlainTextSink();
  return new JsonLogger();
}
