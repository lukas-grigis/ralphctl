/**
 * `SessionManager` — in-memory implementation of {@link SessionManagerPort}.
 *
 * Owns N concurrent `ChainRunner` instances, mirrors their status into
 * `SessionDescriptor` snapshots, and emits a registry-level event stream
 * (`added | removed | active-changed`) the UI consumes.
 *
 * The active session is a single pointer, not a stack. Foregrounding
 * a different session replaces the previous active id — there is no
 * "previous" to pop back to. (TUI navigation history is the router's
 * problem, not ours.)
 *
 * Subscriber discipline matches `signal-bus.ts` and `chain-runner.ts`:
 * a thrown listener never stalls delivery to the rest of the subscriber
 * set. Throws are reported via `console.warn` — the single intentional
 * `console.*` allowance, documented inline. The session manager is
 * pre-logger infrastructure (it runs before any chain has started, and
 * the logger sinks themselves may run inside chains), so injecting a
 * `LoggerPort` would invert the dependency.
 *
 * Type erasure at the registry boundary: `start<TCtx>` is generic, but
 * descriptors are stored as `SessionDescriptor<unknown>` because the
 * registry is heterogeneous. Callers needing typed access should keep
 * their own handle on the runner returned by `start()`.
 */

import { NotFoundError } from '@src/domain/errors/not-found-error.ts';
import { Result } from '@src/domain/result.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { ChainRunner } from '@src/kernel/runtime/chain-runner.ts';
import { defaultSessionIdGenerator } from './session-id-generator.ts';
import type {
  SessionDescriptor,
  SessionId,
  SessionManagerEvent,
  SessionManagerPort,
  SessionManagerStartOptions,
  SessionStatus,
} from './session-manager-port.ts';

export interface SessionManagerOptions {
  /** Override the id generator (tests / deterministic ids). */
  readonly idGenerator?: () => SessionId;
  /** Override the wall-clock source (tests / deterministic timestamps). */
  readonly clock?: () => IsoTimestamp;
}

/**
 * Internal mutable record. The public `SessionDescriptor` is rebuilt
 * from this whenever the status changes — keeping the descriptor as a
 * fresh object ensures React-style consumers can rely on identity
 * equality to detect changes.
 */
interface SessionRecord {
  readonly id: SessionId;
  readonly label: string;
  readonly startedAt: IsoTimestamp;
  readonly runner: ChainRunner<unknown>;
  readonly dedupeKey: string | undefined;
  readonly detachable: boolean;
  /** Promise returned by `runner.start()` — `dispose` awaits this set. */
  readonly startPromise: Promise<void>;
  /** Last published status (kept in sync with the runner). */
  status: SessionStatus;
  /** Last published descriptor — re-emitted reference-equal until status changes. */
  descriptor: SessionDescriptor;
  /** Unsubscribe callback for the runner subscription. */
  unsubscribe: () => void;
}

const TERMINAL_STATUSES: readonly SessionStatus[] = ['completed', 'failed', 'aborted'];

function isTerminal(status: SessionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export class SessionManager implements SessionManagerPort {
  private readonly idGenerator: () => SessionId;
  private readonly clock: () => IsoTimestamp;

  private readonly records = new Map<SessionId, SessionRecord>();
  private readonly listeners = new Set<(event: SessionManagerEvent) => void>();
  private activeId: SessionId | null = null;
  private disposed = false;

  constructor(opts: SessionManagerOptions = {}) {
    this.idGenerator = opts.idGenerator ?? defaultSessionIdGenerator;
    // Bind `IsoTimestamp.now` so `this` inside the helper isn't lost
    // when invoked via `this.clock()` later. The helper is `this`-free
    // today but the binding makes the call site safe regardless.
    this.clock = opts.clock ?? (() => IsoTimestamp.now());
  }

  start<TCtx>(opts: SessionManagerStartOptions<TCtx>): SessionId {
    if (this.disposed) {
      throw new Error('SessionManager: cannot start a session after dispose()');
    }

    // Dedup: if a non-terminal session with the same key already exists,
    // return its id instead of registering a duplicate. The caller can
    // foreground the returned id to land on the existing run. Foreground-
    // only flows (onboard) rely on this to enforce single-instance.
    if (opts.dedupeKey !== undefined && opts.dedupeKey.length > 0) {
      for (const existing of this.records.values()) {
        if (existing.dedupeKey === opts.dedupeKey && !isTerminal(existing.status)) {
          return existing.id;
        }
      }
    }

    const id = this.idGenerator();
    const startedAt = this.clock();
    const detachable = opts.detachable ?? true;
    // The runner is generic on TCtx but stored as `unknown` here — the
    // registry is heterogeneous and the UI only consumes display fields.
    const runner = new ChainRunner({
      id,
      element: opts.element,
      initialCtx: opts.initialCtx,
    });
    const erasedRunner = runner as unknown as ChainRunner<unknown>;

    const initialDescriptor: SessionDescriptor = Object.freeze({
      id,
      label: opts.label,
      status: 'idle' as const,
      startedAt,
      runner: erasedRunner,
      ...(opts.dedupeKey !== undefined ? { dedupeKey: opts.dedupeKey } : {}),
      detachable,
    });

    // Build the record + register it in the map BEFORE wiring the
    // subscription and BEFORE calling `runner.start()`. The runner's
    // `start()` flips `currentStatus` to `'running'` and emits
    // `{ type: 'started' }` SYNCHRONOUSLY (the body of the async `run()`
    // up to its first `await` runs in the same tick). If `records.set`
    // hasn't happened yet, the subscription handler's `records.get(id)`
    // returns undefined and the status flip is silently dropped — the
    // descriptor stays `'idle'` for the lifetime of the session. Bug
    // surfaced as the IDLE chip on the live execute view.
    let unsubscribe: (() => void) | null = null;
    const record: SessionRecord = {
      id,
      label: opts.label,
      startedAt,
      runner: erasedRunner,
      dedupeKey: opts.dedupeKey,
      detachable,
      // startPromise is attached below; populated before any caller can
      // observe the record (we hold the lock on this synchronous block).
      startPromise: undefined as unknown as Promise<void>,
      status: 'idle',
      descriptor: initialDescriptor,
      // unsubscribe wired after subscribe(); see below.
      unsubscribe: () => {
        unsubscribe?.();
      },
    };
    this.records.set(id, record);

    // Mirror runner lifecycle into descriptor.status. `started` flips
    // status to 'running'; terminal events flip to the matching status.
    unsubscribe = erasedRunner.subscribe((event) => {
      const r = this.records.get(id);
      if (!r) return;
      switch (event.type) {
        case 'started':
          this.updateStatus(r, 'running');
          break;
        case 'completed':
          this.updateStatus(r, 'completed');
          break;
        case 'failed':
          this.updateStatus(r, 'failed');
          break;
        case 'aborted':
          this.updateStatus(r, 'aborted');
          break;
        case 'step':
          // Step events are observable on the runner directly; we don't
          // mirror them at the registry level.
          break;
      }
    });

    // Kick off — don't await; `start()` is fire-and-forget at this
    // boundary. The promise is retained on the record so `dispose()`
    // can await every in-flight runner.
    const startPromise = runner.start();
    (record as { startPromise: Promise<void> }).startPromise = startPromise;

    this.emit({ type: 'added', sessionId: id });
    return id;
  }

  list(): readonly SessionDescriptor[] {
    // Map preserves insertion order in JS — exactly what we want.
    return [...this.records.values()].map((r) => r.descriptor);
  }

  get(id: SessionId): SessionDescriptor | undefined {
    return this.records.get(id)?.descriptor;
  }

  foreground(id: SessionId): Result<void, NotFoundError> {
    if (!this.records.has(id)) return Result.error(this.notFound(id));
    if (this.activeId === id) return Result.ok();
    this.activeId = id;
    this.emit({ type: 'active-changed', sessionId: id });
    return Result.ok();
  }

  background(id: SessionId): Result<void, NotFoundError> {
    if (!this.records.has(id)) return Result.error(this.notFound(id));
    if (this.activeId !== id) return Result.ok();
    this.activeId = null;
    this.emit({ type: 'active-changed', sessionId: null });
    return Result.ok();
  }

  kill(id: SessionId): Result<void, NotFoundError> {
    const record = this.records.get(id);
    if (!record) return Result.error(this.notFound(id));

    // Abort propagates synchronously into the runner. The runner's
    // start promise will eventually settle to 'aborted' (or whatever
    // terminal state it landed in just before the abort signal was
    // observed). We do NOT await that here — the registry is cleaned
    // up immediately so the UI sees the session disappear right away.
    // The promise lives on; dispose() awaits it during shutdown.
    record.runner.abort('killed-by-session-manager');
    record.unsubscribe();
    this.records.delete(id);

    if (this.activeId === id) {
      this.activeId = null;
      this.emit({ type: 'active-changed', sessionId: null });
    }
    this.emit({ type: 'removed', sessionId: id });
    return Result.ok();
  }

  get active(): SessionDescriptor | null {
    if (this.activeId === null) return null;
    const record = this.records.get(this.activeId);
    return record ? record.descriptor : null;
  }

  subscribe(listener: (event: SessionManagerEvent) => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    // Snapshot before mutating — dispose path collects every live
    // runner's start promise so we can await them all in parallel.
    const records = [...this.records.values()];
    for (const record of records) {
      record.runner.abort('session-manager-disposed');
      record.unsubscribe();
    }

    // Wait for every runner to settle. `start()` is idempotent and
    // resolves once the run completes (or aborts), so this is bounded
    // by the slowest in-flight chain's abort latency.
    await Promise.allSettled(records.map((r) => r.startPromise));

    this.records.clear();
    this.listeners.clear();
    this.activeId = null;
  }

  // ── internals ────────────────────────────────────────────────────

  private updateStatus(record: SessionRecord, status: SessionStatus): void {
    if (record.status === status) return;
    record.status = status;
    record.descriptor = Object.freeze({
      id: record.id,
      label: record.label,
      status,
      startedAt: record.startedAt,
      runner: record.runner,
      ...(record.dedupeKey !== undefined ? { dedupeKey: record.dedupeKey } : {}),
      detachable: record.detachable,
    });
  }

  private emit(event: SessionManagerEvent): void {
    // Snapshot listeners — a subscriber unsubscribing during dispatch
    // must not skip its peers.
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        // Documented single console allowance — see file header. Same
        // discipline as InMemorySignalBus and ChainRunner: a thrown
        // listener must not stall delivery to the rest of the set.
        console.warn('[session-manager] listener threw:', err);
      }
    }
  }

  private notFound(id: SessionId): NotFoundError {
    return new NotFoundError({ entity: 'session', id });
  }
}
