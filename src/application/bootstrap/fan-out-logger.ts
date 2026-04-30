/**
 * `FanOutLogger` — decorator that broadcasts every log call to multiple
 * `LoggerPort` sinks.
 *
 * Used by the composition root to attach a {@link JsonlFileWriter}-backed
 * sink to any active console sink (PlainText / Json / Ink) so the on-disk
 * `<logsDir>/<sessionId>.jsonl` trace is always written, regardless of
 * which console sink is active.
 *
 * Why a decorator (not dual-write inside the sink): each sink has its own
 * concerns (TTY rendering, JSON encoding, Ink event-bus publish). Having
 * them write to disk too would couple unrelated responsibilities into
 * three places. A decorator keeps the sinks single-purpose and gives the
 * composition root a single seam to attach the file writer.
 */
import type { LogContext, LoggerPort, LogLevel } from '../../business/ports/logger-port.ts';

export class FanOutLogger implements LoggerPort {
  constructor(private readonly sinks: readonly LoggerPort[]) {}

  log(level: LogLevel, message: string, context?: LogContext): void {
    for (const sink of this.sinks) {
      try {
        sink.log(level, message, context);
      } catch {
        // A misbehaving sink must not stop the others. Documented
        // single allowance: `LoggerPort` is the lowest level a logging
        // failure can be surfaced to — escalate via stderr if needed.
      }
    }
  }

  debug(message: string, context?: LogContext): void {
    this.log('debug', message, context);
  }
  info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }
  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }
  error(message: string, context?: LogContext): void {
    this.log('error', message, context);
  }

  child(bound: LogContext): LoggerPort {
    return new FanOutLogger(this.sinks.map((s) => s.child(bound)));
  }

  time(label: string): () => void {
    const start = Date.now();
    return () => {
      this.debug(label, { ms: Date.now() - start });
    };
  }
}
