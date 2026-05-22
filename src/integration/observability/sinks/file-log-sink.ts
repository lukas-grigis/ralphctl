import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type {
  AppEvent,
  ChainAbortedEvent,
  ChainCompletedEvent,
  ChainFailedEvent,
} from '@src/business/observability/events.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

/**
 * Append-only JSONL log of every `AppEvent` published on the bus for the lifetime of one
 * implement (or other long-running) chain. Writes to `<sprintDir>/chain.log`.
 *
 * Why a separate persistent log: in-memory TUI buffers vanish with the process. When the
 * chain dies overnight — Ctrl-C? OOM? host sleep? the operator's host crashed? — the
 * orphan running attempt on disk tells you the chain stopped but not WHY. A persisted log
 * tee'd from the event bus survives the crash and answers that question without re-running
 * the sprint.
 *
 * Format: one JSON object per line. Each line carries the event verbatim (type-tagged
 * AppEvent) so a downstream tool (jq / a future `ralphctl doctor`) can filter cheaply. No
 * frontmatter, no rotation — append-only; the operator removes the file when they want to
 * reset.
 *
 * Chain-run brackets: each chain run is delimited by two human-readable marker lines that
 * start with `=== ` so they are trivially distinguishable from the NDJSON event stream
 * (which always starts with `{`). The header is written immediately before the
 * `chain-started` event line; the footer immediately after the terminal event line
 * (`chain-completed` / `chain-failed` / `chain-aborted`). Format:
 *
 *   === chain-run <chainId> <flowId> started <iso> ===
 *   <NDJSON event lines>
 *   === chain-run <chainId> <flowId> <outcome> <iso> duration=<ms>ms steps=<n> ===
 *
 * `<n>` is the number of completed-or-failed steps observed for the chain. If a chain dies
 * without emitting a terminal event the footer is missing, but the NEXT run's header still
 * appears cleanly — legacy logs without boundaries also parse, so the bracketing is purely
 * additive.
 *
 * Boundary lines deliberately carry no JSON payload — any consumer that wants to filter the
 * NDJSON stream simply skips lines that do not start with `{`.
 *
 * Concurrency: writes go through a serial drain queue. `fs.appendFile` is atomic per-call on
 * POSIX for chunks ≤ PIPE_BUF (4KB on Linux, 512B on macOS guaranteed) but each event line
 * is unbounded (meta payloads can be large), so we serialize to avoid interleaved bytes. The
 * sink itself is single-process; cross-process locking is not needed because `chain.log` is
 * sprint-scoped and the harness's repo lock prevents concurrent chains on the same sprint.
 *
 * Back-pressure: the in-memory queue is capped at {@link MAX_QUEUE}. When the cap is hit the
 * sink drops the inbound event (drop-newest policy — newest events are the cheapest to lose
 * because the older queued ones carry context the operator will need to reconstruct what
 * happened). The first time either back-pressure OR an actual write failure occurs the sink
 * publishes a single `chain-log-degraded` event onto the bus, then stays silent for the rest
 * of its lifetime (one-shot contract — the banner only needs to latch once; spamming the bus
 * with every subsequent drop or failure would compete with real signal for screen real estate
 * and re-enter the sink's own queue).
 *
 * `emit` is fire-and-forget (sync). Failures are silenced at the write layer — a log sink
 * must NEVER take down the chain. `flush()` returns once the queue drains, used in tests +
 * shutdown.
 */

/**
 * Maximum events the in-memory drain queue can hold before the sink starts dropping the
 * newest inbound events. 10_000 is enough headroom that a transient disk-write stall (e.g.
 * spinning-disk fsync spike, fuse-mount slowdown) won't trip the cap; if the gap is sustained
 * the operator wants to know the log is no longer complete rather than silently accruing
 * unbounded RAM.
 */
const MAX_QUEUE = 10_000;

const isMissingPathError = (err: unknown): boolean => {
  if (err === null || typeof err !== 'object') return false;
  const code = (err as { readonly code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

export interface FileLogSinkDeps {
  /** Absolute path to the JSONL file. Parent directory is created on first write. */
  readonly file: AbsolutePath;
  /** Event bus to subscribe to. The sink installs its own handler. */
  readonly bus: EventBus;
}

export interface FileLogSink {
  /** Unsubscribe from the bus. Idempotent. Pending writes still drain. */
  stop(): void;
  /** Resolves once every queued event has been written. Errors are swallowed. */
  flush(): Promise<void>;
}

interface ChainState {
  readonly flowId: string;
  readonly startedAtMs: number;
  steps: number;
}

type ChainTerminalEvent = ChainCompletedEvent | ChainFailedEvent | ChainAbortedEvent;

const isTerminalChainEvent = (event: AppEvent): event is ChainTerminalEvent =>
  event.type === 'chain-completed' || event.type === 'chain-failed' || event.type === 'chain-aborted';

const terminalOutcome = (type: ChainTerminalEvent['type']): string => {
  switch (type) {
    case 'chain-completed':
      return 'completed';
    case 'chain-failed':
      return 'failed';
    case 'chain-aborted':
      return 'aborted';
  }
};

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

export const startFileLogSink = (deps: FileLogSinkDeps): FileLogSink => {
  // Queue holds pre-rendered text payloads — either an NDJSON event line or a `=== ` boundary
  // marker. Render-at-enqueue keeps the drain loop trivial and lets boundary lines share the
  // same back-pressure / write-fail path as event lines.
  const queue: string[] = [];
  let draining: Promise<void> | undefined;
  let dirEnsured = false;
  let stopped = false;
  // Latches once the sink has published `chain-log-degraded` for the first time. Subsequent
  // queue overflows and write failures are silenced — the banner is already up; re-emitting
  // would spam the bus and (worse) re-enter the sink's own queue.
  let degraded = false;

  // Per-chain bracket state. Populated on `chain-started`, consumed and removed on the
  // matching terminal event. A chain that never emits a terminal (process killed mid-run)
  // leaves its entry orphaned in memory until the sink is stopped — bounded by the number of
  // distinct chainIds the sink sees, which is at most ~one per launcher invocation.
  const chains = new Map<string, ChainState>();

  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) continue;
      try {
        if (!dirEnsured) {
          await fs.mkdir(dirname(String(deps.file)), { recursive: true });
          dirEnsured = true;
        }
        // TODO(wave-7): route via the AppendFile port (audit-[07]). Pre-existing call site
        // grandfathered ahead of Wave 6's fs.appendFile fence.
        // eslint-disable-next-line no-restricted-syntax
        await fs.appendFile(String(deps.file), next, 'utf8');
      } catch (err) {
        // Best-effort write — never take down the chain. But fire the one-shot degradation
        // marker so the operator knows the on-disk trace is incomplete.
        // If the parent directory disappeared after our initial mkdir (tmpfs cleanup, fuse
        // remount, operator `rm -rf` of the sprint dir), `dirEnsured` is stale — drop it so
        // the next iteration re-creates the directory before retrying the append.
        if (isMissingPathError(err)) dirEnsured = false;
        if (!degraded) {
          degraded = true;
          deps.bus.publish({
            type: 'chain-log-degraded',
            reason: 'write-failed',
            meta: { error: err instanceof Error ? err.message : String(err) },
            at: IsoTimestamp.now(),
          });
        }
      }
    }
    draining = undefined;
  };

  const enqueue = (line: string): boolean => {
    if (queue.length >= MAX_QUEUE) {
      if (!degraded) {
        degraded = true;
        deps.bus.publish({
          type: 'chain-log-degraded',
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
    // Re-entrancy guard: never enqueue our own degradation marker. Without this the first
    // write failure would publish the marker, which would synchronously land back here and
    // get appended — round-tripping the event we are trying to surface and (worse) putting it
    // on a queue that may itself be in trouble.
    if (event.type === 'chain-log-degraded') return;

    // Bracket state tracking — header BEFORE the chain-started event line, footer AFTER the
    // terminal event line. The boundary lines start with `=== ` so an NDJSON consumer skips
    // them by ignoring any line that doesn't start with `{`.
    if (event.type === 'chain-started') {
      chains.set(event.chainId, {
        flowId: event.flowId,
        startedAtMs: Date.parse(event.at),
        steps: 0,
      });
      enqueue(headerLine(event.chainId, event.flowId, event.at));
      enqueue(`${JSON.stringify(event)}\n`);
      return;
    }

    if (event.type === 'chain-step-completed' || event.type === 'chain-step-failed') {
      const state = chains.get(event.chainId);
      if (state !== undefined) state.steps += 1;
      enqueue(`${JSON.stringify(event)}\n`);
      return;
    }

    if (isTerminalChainEvent(event)) {
      enqueue(`${JSON.stringify(event)}\n`);
      const state = chains.get(event.chainId);
      if (state !== undefined) {
        chains.delete(event.chainId);
        const endedMs = Date.parse(event.at);
        const durationMs = Number.isFinite(endedMs - state.startedAtMs) ? Math.max(0, endedMs - state.startedAtMs) : 0;
        enqueue(
          footerLine(event.chainId, state.flowId, terminalOutcome(event.type), event.at, durationMs, state.steps)
        );
      }
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
