import type {
  AppEvent,
  ChainAbortedEvent,
  ChainCompletedEvent,
  ChainFailedEvent,
  ChainStartedEvent,
  ChainStepCompletedEvent,
  ChainStepFailedEvent,
} from '@src/business/observability/events.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { FileLogSink, FileLogSinkDeps } from '@src/integration/observability/_engine/file-log-sink.ts';

/**
 * Opt-in (`RALPHCTL_DEBUG_TRACE=1`) append-only NDJSON trace of every bus event, written to
 * `<sprintDir>/events.ndjson` so a chain that died overnight still says why. One JSON event per
 * line; each chain run is bracketed by `=== chain-run … ===` marker lines (a consumer skips any
 * line not starting with `{`):
 *
 *   === chain-run <chainId> <flowId> started <iso> ===
 *   <NDJSON event lines>
 *   === chain-run <chainId> <flowId> <outcome> <iso> duration=<ms>ms steps=<n> ===
 *
 * A chain killed without a terminal event simply has no footer.
 *
 * Writes go through one serial drain (an event line can exceed PIPE_BUF, so concurrent appends
 * could interleave), batched per burst. `emit` never throws — a log sink must never take down
 * the chain. The first queue overflow or write failure publishes one `chain-log-degraded` event;
 * later ones stay silent so the banner latches once instead of spamming the bus.
 */

/** Drop-newest cap on pending lines: survives a disk stall, but never accrues unbounded RAM. */
const MAX_QUEUE = 10_000;

const CHAIN_LOG_DEGRADED = 'chain-log-degraded';

interface ChainState {
  readonly flowId: string;
  readonly startedAtMs: number;
  steps: number;
}

type ChainTerminalEvent = ChainCompletedEvent | ChainFailedEvent | ChainAbortedEvent;

const isTerminalChainEvent = (event: AppEvent): event is ChainTerminalEvent =>
  event.type === 'chain-completed' || event.type === 'chain-failed' || event.type === 'chain-aborted';

const terminalOutcome = (type: ChainTerminalEvent['type']): string => type.slice('chain-'.length);

const headerLine = (chainId: string, flowId: string, startedAt: IsoTimestamp): string =>
  `=== chain-run ${chainId} ${flowId} started ${startedAt} ===\n`;

const footerLine = (
  chainId: string,
  flowId: string,
  outcome: string,
  endedAt: IsoTimestamp,
  durationMs: number,
  steps: number
): string => `=== chain-run ${chainId} ${flowId} ${outcome} ${endedAt} duration=${durationMs}ms steps=${steps} ===\n`;

/** A queued NDJSON line, or `false` when the drain queue rejected it (back-pressure). */
type Enqueue = (line: string) => boolean;

/** `chain-started` — open the chain-run bracket: seed `chains` state, then the header + event line. */
const handleChainStarted = (event: ChainStartedEvent, chains: Map<string, ChainState>, enqueue: Enqueue): void => {
  chains.set(event.chainId, { flowId: event.flowId, startedAtMs: Date.parse(event.at), steps: 0 });
  enqueue(headerLine(event.chainId, event.flowId, event.at));
  enqueue(`${JSON.stringify(event)}\n`);
};

/** `chain-step-completed` / `chain-step-failed` — tally the step count for the eventual footer. */
const handleChainStepEvent = (
  event: ChainStepCompletedEvent | ChainStepFailedEvent,
  chains: Map<string, ChainState>,
  enqueue: Enqueue
): void => {
  const state = chains.get(event.chainId);
  if (state !== undefined) state.steps += 1;
  enqueue(`${JSON.stringify(event)}\n`);
};

/** `chain-completed` / `chain-failed` / `chain-aborted` — close the bracket with the footer line. */
const handleTerminalChainEvent = (
  event: ChainTerminalEvent,
  chains: Map<string, ChainState>,
  enqueue: Enqueue
): void => {
  enqueue(`${JSON.stringify(event)}\n`);
  const state = chains.get(event.chainId);
  if (state === undefined) return;
  chains.delete(event.chainId);
  const endedMs = Date.parse(event.at);
  const durationMs = Number.isFinite(endedMs - state.startedAtMs) ? Math.max(0, endedMs - state.startedAtMs) : 0;
  enqueue(footerLine(event.chainId, state.flowId, terminalOutcome(event.type), event.at, durationMs, state.steps));
};

export const startFileLogSink = (deps: FileLogSinkDeps): FileLogSink => {
  // Pre-rendered lines (events and `=== ` markers alike), so both share back-pressure and failure handling.
  const queue: string[] = [];
  let draining: Promise<void> | undefined;
  let stopped = false;
  let degraded = false;
  // An entry whose chain never terminates stays until stop — at most about one per launch.
  const chains = new Map<string, ChainState>();

  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      // One append per burst, not per line. `AppendFile` re-ensures the directory on every call,
      // so a failed write heals on the next burst.
      const result = await deps.appendFile(deps.file, queue.splice(0).join(''));
      if (!result.ok && !degraded) {
        degraded = true;
        deps.bus.publish({
          type: CHAIN_LOG_DEGRADED,
          reason: 'write-failed',
          meta: { error: result.error.message },
          at: IsoTimestamp.now(),
        });
      }
    }
    draining = undefined;
  };

  const enqueue = (line: string): boolean => {
    if (queue.length >= MAX_QUEUE) {
      if (!degraded) {
        degraded = true;
        deps.bus.publish({
          type: CHAIN_LOG_DEGRADED,
          reason: 'queue-full',
          at: IsoTimestamp.now(),
        });
      }
      return false;
    }
    queue.push(line);
    if (draining === undefined) draining = drain();
    return true;
  };

  const onEvent = (event: AppEvent): void => {
    if (stopped) return;
    // Our own marker would land straight back here, onto a queue that may itself be in trouble.
    if (event.type === CHAIN_LOG_DEGRADED) return;

    if (event.type === 'chain-started') {
      handleChainStarted(event, chains, enqueue);
      return;
    }

    if (event.type === 'chain-step-completed' || event.type === 'chain-step-failed') {
      handleChainStepEvent(event, chains, enqueue);
      return;
    }

    if (isTerminalChainEvent(event)) {
      handleTerminalChainEvent(event, chains, enqueue);
      return;
    }

    enqueue(`${JSON.stringify(event)}\n`);
  };

  const unsubscribe = deps.bus.subscribe(onEvent);

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      unsubscribe();
    },
    async flush(): Promise<void> {
      if (draining !== undefined) await draining;
    },
  };
};
