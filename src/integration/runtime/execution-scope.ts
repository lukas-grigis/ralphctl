/**
 * Per-execution SharedDeps scope.
 *
 * `createExecutionScope` returns a SharedDeps graph where `signalBus` and
 * `logger` are swapped for execution-specific instances so concurrent sprint
 * executions do not cross-talk on shared buses. Every other port in the
 * graph (persistence, filesystem, AI session, prompt, process lifecycle,
 * execution registry itself) is carried through unchanged.
 *
 * Layout choices:
 *   - `signalBus` is the scoped `InMemorySignalBus` the caller constructed —
 *     subscribers of that specific bus see only this execution's signals.
 *   - `logger` is rebased on the caller-provided `LogEventBus` when the base
 *     logger is an `InkSink` so UI subscribers scoped to this bus receive only
 *     this execution's log events. For non-Ink bases (plain text, JSON) the
 *     execution id is folded in via `child({ executionId })` and no bus swap
 *     happens — those sinks write directly to stdout and there is no shared
 *     event stream to scope.
 *   - `abortController` is intentionally not part of the returned SharedDeps.
 *     The registry plumbs the controller's `signal` into `executePipeline`'s
 *     `abortSignal` argument directly; keeping it out of the shared graph
 *     prevents mis-use (e.g. a nested use case aborting the entire execution).
 */

import type { SharedDeps } from '@src/integration/shared-deps.ts';
import type { SignalBusPort } from '@src/business/ports/signal-bus.ts';
import type { LogEventBus } from '@src/business/ports/log-event-bus.ts';
import { InkSink } from '@src/integration/logging/ink-sink.ts';

export interface ExecutionScopeArgs {
  executionId: string;
  logEventBus: LogEventBus;
  signalBus: SignalBusPort;
  abortController: AbortController;
}

export function createExecutionScope(baseShared: SharedDeps, args: ExecutionScopeArgs): SharedDeps {
  const scopedLogger =
    baseShared.logger instanceof InkSink
      ? new InkSink({ executionId: args.executionId }, args.logEventBus)
      : baseShared.logger.child({ executionId: args.executionId });

  return {
    ...baseShared,
    signalBus: args.signalBus,
    logger: scopedLogger,
  };
}
