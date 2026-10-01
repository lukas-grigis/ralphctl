/** Provides the TUI's bus sinks (harness + log) via React context. */

import React, { createContext, useContext } from 'react';
import type { HarnessSignal } from '@src/domain/signal.ts';
import type { LogEvent } from '@src/business/observability/events.ts';
import type { BusSink } from '@src/application/ui/tui/runtime/sinks-bus.ts';

/**
 * One harness-signal bus entry — the TUI-side re-shaping of the `ai-signal` AppEvent's payload. `source` is the
 * leaf/flow that produced it; `taskId` is set only on the implement flow's parallel path.
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
