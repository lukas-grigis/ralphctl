/**
 * Provides the TUI's bus sinks (harness + log) via React context. Views subscribe through the
 * hooks in `use-sink-stream.ts`; the production composition root's `launch.ts` forwards the
 * EventBus's `'ai-signal'` / `'log'` AppEvents into these buses (see `createSignalForwarder` /
 * `createLogForwarder`).
 */

import React, { createContext, useContext } from 'react';
import type { HarnessSignal } from '@src/domain/signal.ts';
import type { LogEvent } from '@src/business/observability/events.ts';
import type { BusSink } from '@src/application/ui/tui/runtime/sinks-bus.ts';

/**
 * One harness-signal bus entry — the TUI-side re-shaping of the `ai-signal` AppEvent's payload.
 *
 *  - `source` — the leaf/flow that produced the signal (e.g. `'generator'`, `'implement'`,
 *    `'detect-scripts'`).
 *  - `taskId` — present only when the implement flow's parallel per-branch publisher stamped it
 *    (see `wave-branch.ts`'s `perBranchSignalPublisher`). Absent on the implement serial path and
 *    every other flow; `bucketTaskSignals` falls back to its timestamp-window heuristic then.
 */
export interface SignalBusEntry {
  readonly signal: HarnessSignal;
  readonly source: string;
  readonly taskId?: string;
}

export interface TuiBuses {
  readonly harness: BusSink<SignalBusEntry>;
  readonly log: BusSink<LogEvent>;
}

const BusesContext = createContext<TuiBuses | undefined>(undefined);

export interface BusesProviderProps {
  readonly value: TuiBuses;
  readonly children: React.ReactNode;
}

export const BusesProvider = ({ value, children }: BusesProviderProps): React.JSX.Element => (
  <BusesContext.Provider value={value}>{children}</BusesContext.Provider>
);

export const useBuses = (): TuiBuses => {
  const ctx = useContext(BusesContext);
  if (!ctx) throw new Error('useBuses: must be used inside <BusesProvider>');
  return ctx;
};
