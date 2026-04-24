/**
 * Signal bus port — observable signal stream parallel to SignalHandlerPort.
 *
 * Where SignalHandlerPort writes signals to durable storage (progress.md,
 * evaluations/, tasks.json), the SignalBus broadcasts the same signals to
 * in-memory subscribers (the live TUI dashboard). Two sinks, one source.
 *
 * Emissions are micro-batched (coalesced within one animation frame) to
 * avoid overwhelming React re-renders under high-volume AI output.
 */

import type { HarnessSignal } from '@src/domain/signals.ts';
import type { SignalContext } from '@src/business/ports/signal-handler.ts';

/**
 * Ephemeral synthetic events emitted by the harness alongside real signals —
 * e.g. rate-limit pause/resume — that the dashboard needs to render but
 * that don't originate from AI output.
 */
export type HarnessEvent =
  | { type: 'signal'; signal: HarnessSignal; ctx: SignalContext }
  | { type: 'rate-limit-paused'; delayMs: number; timestamp: Date }
  | { type: 'rate-limit-resumed'; timestamp: Date }
  | { type: 'task-started'; sprintId: string; taskId: string; taskName: string; timestamp: Date }
  | {
      type: 'task-finished';
      sprintId: string;
      taskId: string;
      status: 'done' | 'blocked' | 'failed' | 'cancelled';
      timestamp: Date;
    }
  | {
      type: 'task-step';
      sprintId: string;
      taskId: string;
      stepName: string;
      phase: 'start' | 'finish';
      timestamp: Date;
    };

export type Unsubscribe = () => void;

export interface SignalBusPort {
  emit(event: HarnessEvent): void;
  subscribe(listener: (events: readonly HarnessEvent[]) => void): Unsubscribe;
  /** Drop all buffered events and subscribers. Call on app shutdown. */
  dispose(): void;
}
