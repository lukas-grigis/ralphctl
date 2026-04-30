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
import type { HarnessSignal } from '../../domain/signals/harness-signal.ts';
import type { IsoTimestamp } from '../../domain/values/iso-timestamp.ts';
import type { SprintId } from '../../domain/values/sprint-id.ts';
import type { TaskId } from '../../domain/values/task-id.ts';

/**
 * Discriminated union of every event flowing on the bus. Real signals flow
 * as `{ type: 'signal', signal, … }`; synthetic harness events (rate limit,
 * task lifecycle) flow as their own variants.
 */
export type SignalBusEvent =
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
    };

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
