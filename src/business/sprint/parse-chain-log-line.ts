import type { ChainLogEntry } from '@src/business/sprint/state-projection.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

/**
 * Parse one line of a `<sprintDir>/chain.log` file into a {@link ChainLogEntry}.
 *
 * The file format is the {@link AppEvent} stream the `startFileLogSink` writes:
 *
 *   `=== chain-run <chainId> <flowId> started <iso> ===`  ← human-readable boundary
 *   `{ "type": "chain-started", ... }`                    ← NDJSON event
 *   `{ "type": "chain-step-completed", ... }`
 *   …
 *   `=== chain-run <chainId> <flowId> completed <iso> duration=<ms>ms steps=<n> ===`
 *
 * This parser is intentionally tolerant — the on-disk file outlives any single ralphctl version
 * and may carry events authored before fields existed. Returns `undefined` for:
 *  - blank lines
 *  - boundary lines (starting with `=== `)
 *  - malformed JSON
 *  - events we don't normalize (no `type` field, etc.)
 *
 * Normalisation policy for the {@link ChainLogEntry} shape the projection consumes:
 *  - `timestamp` ← `at` (every AppEvent carries it)
 *  - `chainId`   ← `chainId` if present; `''` for events without one (LogEvent,
 *                  MemoryPressureEvent, ChainLogDegradedEvent). The projection's run grouper
 *                  filters empty-id buckets at the read-site.
 *  - `level`     ← `level` for LogEvent; `'info'` otherwise
 *  - `event`     ← the raw `type` discriminator
 *  - `message`   ← LogEvent `message`; empty string for events that don't carry prose
 *  - `meta`      ← per-variant correlation bag (`taskId`, `flowId`, `elementName`, …) so the
 *                  stale-task heuristic and future decision miner can read structured fields
 *
 * Pure — no IO, no throws. A parse error returns `undefined` so the loader can collect a list
 * and the snapshot writer can warn-and-continue without aborting the whole render.
 *
 * @public
 */
export const parseChainLogLine = (line: string): ChainLogEntry | undefined => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  // Boundary markers and any other non-JSON noise are skipped.
  if (!trimmed.startsWith('{')) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const raw = parsed as Readonly<Record<string, unknown>>;
  const type = raw['type'];
  const at = raw['at'];
  if (typeof type !== 'string' || typeof at !== 'string') return undefined;

  const chainId = typeof raw['chainId'] === 'string' ? raw['chainId'] : '';
  const level = type === 'log' && typeof raw['level'] === 'string' ? raw['level'] : 'info';
  // For `harness-signal` entries we surface the signal text via `message` so downstream
  // miners (e.g. `collectPerTaskSignals` in `state-projection.ts`) can read it without a
  // bespoke shape. The `log` case keeps its original behaviour.
  const message =
    type === 'log' && typeof raw['message'] === 'string'
      ? raw['message']
      : type === 'harness-signal' && typeof raw['text'] === 'string'
        ? raw['text']
        : '';
  const meta = buildMeta(type, raw);

  return {
    timestamp: at as IsoTimestamp,
    chainId,
    level,
    event: type,
    message,
    ...(meta !== undefined ? { meta } : {}),
  };
};

/**
 * Project per-variant correlation handles into the flat `meta` bag the projection reads. The
 * shape is intentionally narrow — only fields the downstream consumers (stale heuristic, run
 * grouper, future decision miner) actually look at. New AppEvent variants can extend this
 * without changing the {@link ChainLogEntry} contract.
 */
const buildMeta = (
  type: string,
  raw: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> | undefined => {
  const out: Record<string, unknown> = {};

  if (type === 'log' && typeof raw['meta'] === 'object' && raw['meta'] !== null) {
    Object.assign(out, raw['meta'] as Record<string, unknown>);
  }

  for (const key of ['taskId', 'flowId', 'elementName', 'sessionId', 'attemptN', 'roundN', 'verdict', 'signalKind']) {
    if (key in raw && raw[key] !== undefined && !(key in out)) {
      out[key] = raw[key];
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
};
