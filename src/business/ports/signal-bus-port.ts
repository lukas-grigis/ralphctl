/**
 * `SignalBusPort` — observable signal stream parallel to
 * `SignalHandlerPort`. Where the handler writes signals to durable storage
 * (progress.md, evaluations/, tasks.json), the bus broadcasts the same
 * signals + synthetic lifecycle events to in-memory subscribers (the live
 * TUI dashboard, log tails, etc.). Two sinks, one source.
 *
 * Subscribers receive events in emission order. A failing listener does
 * NOT stall delivery to other listeners — adapters wrap each invocation
 * defensively. Adapters are free to micro-batch within ~16 ms (one
 * animation frame) to avoid React render storms.
 */
import type { HarnessSignal } from '@src/domain/signals/harness-signal.ts';
import type { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import type { TaskId } from '@src/domain/values/task-id.ts';

/**
 * Per-event metadata stamped on every variant. `sessionId` is auto-attached
 * by the bus when the emit call was made inside a `ChainRunner` ALS scope
 * (see `kernel/runtime/session-context.ts`); consumers filter by it to
 * route events to the right per-session view. Out-of-chain emissions
 * (e.g. bootstrap rate-limit listener fired before any chain has launched)
 * leave `sessionId` undefined, which is correct.
 */
export interface SignalBusEventMeta {
  /** Session id of the chain that emitted the event, when known. */
  readonly sessionId?: string;
}

/**
 * Discriminated union of every event flowing on the bus. Real signals flow
 * as `{ type: 'signal', signal, … }`; synthetic harness events (rate limit,
 * task lifecycle) flow as their own variants.
 *
 * Every variant intersects with {@link SignalBusEventMeta} so it carries
 * the optional `sessionId` tag without each variant having to declare it.
 */
export type SignalBusEvent = SignalBusEventMeta &
  (
    | {
        readonly type: 'signal';
        readonly signal: HarnessSignal;
        readonly sprintId: SprintId;
        readonly taskId?: TaskId;
      }
    | {
        readonly type: 'rate-limit-paused';
        readonly reason: string;
        readonly resumeAt?: IsoTimestamp;
      }
    | { readonly type: 'rate-limit-resumed' }
    | { readonly type: 'task-started'; readonly taskId: TaskId }
    | {
        readonly type: 'task-finished';
        readonly taskId: TaskId;
        readonly status: 'completed' | 'failed' | 'blocked';
      }
  );

export interface SignalBusPort {
  /** Push an event to every subscriber. Synchronous; adapters may batch internally. */
  emit(event: SignalBusEvent): void;
  /**
   * Register a listener; returns an unsubscribe function. Listener
   * exceptions never block other listeners.
   */
  subscribe(listener: (event: SignalBusEvent) => void): () => void;
  /** Drain buffered events and drop subscribers. Call on shutdown. */
  dispose(): void;
}
